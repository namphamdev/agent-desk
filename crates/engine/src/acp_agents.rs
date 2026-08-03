//! Device-local ACP agent registry and installation state.

use std::collections::BTreeMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context as _, anyhow, bail};
use comet_proto::{AcpAgentsSnapshot, AcpRegistryAgent, InstalledAcpAgent};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const ACP_CONFIG_FILE: &str = "acp-agents.json";
const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone)]
pub struct AcpAgents {
    data_dir: Arc<PathBuf>,
    client: reqwest::Client,
    mutation: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct AcpConfig {
    active_agent_id: Option<String>,
    agents: Vec<InstalledAcpAgent>,
}

#[derive(Debug, Deserialize)]
struct RegistryIndex {
    agents: Vec<RegistryEntry>,
}

#[derive(Debug, Clone, Deserialize)]
struct RegistryEntry {
    id: String,
    name: String,
    version: String,
    description: String,
    #[serde(default)]
    repository: Option<String>,
    #[serde(default)]
    website: Option<String>,
    distribution: RegistryDistribution,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct RegistryDistribution {
    #[serde(default)]
    binary: BTreeMap<String, BinaryDistribution>,
    #[serde(default)]
    npx: Option<PackageDistribution>,
    #[serde(default)]
    uvx: Option<PackageDistribution>,
}

#[derive(Debug, Clone, Deserialize)]
struct BinaryDistribution {
    archive: String,
    #[serde(default)]
    sha256: Option<String>,
    cmd: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
struct PackageDistribution {
    package: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchConfig<'a> {
    command: &'a Path,
    args: &'a [String],
    env: &'a BTreeMap<String, String>,
}

impl AcpAgents {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: Arc::new(data_dir.into()),
            client: reqwest::Client::builder()
                .user_agent(concat!("comet-native/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("valid ACP registry HTTP client"),
            mutation: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    pub fn config_path(&self) -> PathBuf {
        self.data_dir.join(ACP_CONFIG_FILE)
    }

    pub async fn list(&self) -> anyhow::Result<AcpAgentsSnapshot> {
        let config = self.load_config()?;
        match self.fetch_registry().await {
            Ok(entries) => Ok(snapshot(config, entries, None)),
            Err(error) => Ok(snapshot(config, vec![], Some(format!("{error:#}")))),
        }
    }

    pub async fn install(&self, agent_id: &str) -> anyhow::Result<AcpAgentsSnapshot> {
        let _guard = self.mutation.lock().await;
        let entries = self.fetch_registry().await?;
        let entry = entries
            .iter()
            .find(|entry| entry.id == agent_id)
            .cloned()
            .ok_or_else(|| anyhow!("ACP registry agent not found: {agent_id}"))?;
        let installed = self.install_entry(&entry).await?;
        let mut config = self.load_config()?;
        config.agents.retain(|agent| agent.id != installed.id);
        config.agents.push(installed.clone());
        config.agents.sort_by(|a, b| a.name.cmp(&b.name));
        config.active_agent_id = Some(installed.id);
        self.save_config(&config)?;
        Ok(snapshot(config, entries, None))
    }

    pub async fn activate(&self, agent_id: &str) -> anyhow::Result<AcpAgentsSnapshot> {
        let _guard = self.mutation.lock().await;
        let mut config = self.load_config()?;
        if !config.agents.iter().any(|agent| agent.id == agent_id) {
            bail!("ACP agent is not installed: {agent_id}");
        }
        config.active_agent_id = Some(agent_id.to_string());
        self.save_config(&config)?;
        self.list().await
    }

    pub async fn remove(&self, agent_id: &str) -> anyhow::Result<AcpAgentsSnapshot> {
        let _guard = self.mutation.lock().await;
        let mut config = self.load_config()?;
        let removed = config
            .agents
            .iter()
            .find(|agent| agent.id == agent_id)
            .cloned();
        let before = config.agents.len();
        config.agents.retain(|agent| agent.id != agent_id);
        if before == config.agents.len() {
            bail!("ACP agent is not installed: {agent_id}");
        }
        if config.active_agent_id.as_deref() == Some(agent_id) {
            config.active_agent_id = config.agents.first().map(|agent| agent.id.clone());
        }
        self.save_config(&config)?;
        if removed.is_some_and(|agent| agent.distribution == "binary") {
            let directory = self
                .data_dir
                .join("acp-agents")
                .join(safe_component(agent_id));
            tokio::task::spawn_blocking(move || match std::fs::remove_dir_all(directory) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error),
            })
            .await
            .context("join ACP agent removal")??;
        }
        self.list().await
    }

    async fn fetch_registry(&self) -> anyhow::Result<Vec<RegistryEntry>> {
        let response = self
            .client
            .get(REGISTRY_URL)
            .send()
            .await
            .context("fetch ACP registry")?
            .error_for_status()
            .context("ACP registry returned an error")?;
        Ok(response
            .json::<RegistryIndex>()
            .await
            .context("decode ACP registry")?
            .agents)
    }

    async fn install_entry(&self, entry: &RegistryEntry) -> anyhow::Result<InstalledAcpAgent> {
        if let Some(binary) = entry.distribution.binary.get(platform_target()) {
            return self.install_binary(entry, binary).await;
        }
        if let Some(npx) = &entry.distribution.npx {
            if let Some(executable) = installed_npx_executable(npx) {
                return direct_package_agent(entry, npx, executable);
            }
            if find_executable("npx").is_some() {
                return package_agent(entry, "npx", npx, &["--yes"]);
            }
        }
        if let Some(uvx) = &entry.distribution.uvx
            && find_executable("uvx").is_some()
        {
            return package_agent(entry, "uvx", uvx, &[]);
        }
        bail!(
            "{} has no usable distribution for this device (install npx or uvx if the agent is \
             package-backed)",
            entry.name
        )
    }

    async fn install_binary(
        &self,
        entry: &RegistryEntry,
        binary: &BinaryDistribution,
    ) -> anyhow::Result<InstalledAcpAgent> {
        let response = self
            .client
            .get(&binary.archive)
            .send()
            .await
            .with_context(|| format!("download {}", entry.name))?
            .error_for_status()
            .with_context(|| format!("download {}", entry.name))?;
        if response
            .content_length()
            .is_some_and(|size| size > MAX_ARCHIVE_BYTES)
        {
            bail!("{} archive is larger than 512 MiB", entry.name);
        }
        let bytes = response.bytes().await.context("read ACP agent archive")?;
        if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
            bail!("{} archive is larger than 512 MiB", entry.name);
        }
        if let Some(expected) = &binary.sha256 {
            let actual = format!("{:x}", Sha256::digest(&bytes));
            if !actual.eq_ignore_ascii_case(expected) {
                bail!("{} archive checksum did not match the registry", entry.name);
            }
        }

        let root = self
            .data_dir
            .join("acp-agents")
            .join(safe_component(&entry.id));
        let version_dir = root.join(safe_component(&entry.version));
        let archive = binary.archive.clone();
        let command = binary.cmd.clone();
        let bytes = bytes.to_vec();
        let executable = tokio::task::spawn_blocking(move || {
            install_archive(&root, &version_dir, &archive, &command, &bytes)
        })
        .await
        .context("join ACP installer")??;
        let command_json = launch_json(&executable, &binary.args, &binary.env)?;
        Ok(InstalledAcpAgent {
            id: entry.id.clone(),
            name: entry.name.clone(),
            version: entry.version.clone(),
            command: command_json,
            distribution: "binary".into(),
        })
    }

    fn load_config(&self) -> anyhow::Result<AcpConfig> {
        match std::fs::read_to_string(self.config_path()) {
            Ok(json) => serde_json::from_str(&json).context("decode ACP agent settings"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AcpConfig::default()),
            Err(error) => Err(error).context("read ACP agent settings"),
        }
    }

    fn save_config(&self, config: &AcpConfig) -> anyhow::Result<()> {
        std::fs::create_dir_all(self.data_dir.as_path())?;
        let path = self.config_path();
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(config)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }
}

fn snapshot(
    config: AcpConfig,
    entries: Vec<RegistryEntry>,
    registry_error: Option<String>,
) -> AcpAgentsSnapshot {
    AcpAgentsSnapshot {
        active_agent_id: config.active_agent_id,
        installed: config.agents,
        registry: entries
            .into_iter()
            .map(|entry| {
                let distribution = supported_distribution(&entry.distribution);
                AcpRegistryAgent {
                    id: entry.id,
                    name: entry.name,
                    version: entry.version,
                    description: entry.description,
                    repository: entry.repository,
                    website: entry.website,
                    supported: distribution.is_some(),
                    distribution: distribution.map(str::to_string),
                }
            })
            .collect(),
        registry_error,
    }
}

fn supported_distribution(distribution: &RegistryDistribution) -> Option<&'static str> {
    if distribution.binary.contains_key(platform_target()) {
        Some("binary")
    } else if let Some(npx) = &distribution.npx {
        if installed_npx_executable(npx).is_some() {
            Some("direct")
        } else if find_executable("npx").is_some() {
            Some("npx")
        } else {
            None
        }
    } else if distribution.uvx.is_some() && find_executable("uvx").is_some() {
        Some("uvx")
    } else {
        None
    }
}

fn installed_npx_executable(package: &PackageDistribution) -> Option<PathBuf> {
    npx_executable_name(&package.package).and_then(find_executable)
}

fn npx_executable_name(package: &str) -> Option<&str> {
    let package = if package.starts_with('@') {
        let slash = package.find('/')?;
        match package.rfind('@') {
            Some(version) if version > slash => &package[..version],
            _ => package,
        }
    } else {
        package.split_once('@').map_or(package, |(name, _)| name)
    };
    let name = if let Some(scoped) = package.strip_prefix('@') {
        let (scope, name) = scoped.split_once('/')?;
        if scope.is_empty() || name.contains('/') {
            return None;
        }
        name
    } else {
        if package.contains('/') {
            return None;
        }
        package
    };
    (!name.is_empty()
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_')))
    .then_some(name)
}

fn direct_package_agent(
    entry: &RegistryEntry,
    package: &PackageDistribution,
    executable: PathBuf,
) -> anyhow::Result<InstalledAcpAgent> {
    let mut env = package.env.clone();
    prepend_executable_path(&mut env, &executable);
    Ok(InstalledAcpAgent {
        id: entry.id.clone(),
        name: entry.name.clone(),
        version: entry.version.clone(),
        command: launch_json(&executable, &package.args, &env)?,
        distribution: "direct".into(),
    })
}

fn package_agent(
    entry: &RegistryEntry,
    runner: &str,
    package: &PackageDistribution,
    prefix_args: &[&str],
) -> anyhow::Result<InstalledAcpAgent> {
    let executable = find_executable(runner)
        .ok_or_else(|| anyhow!("{runner} is required to install {}", entry.name))?;
    let mut args: Vec<String> = prefix_args.iter().map(|arg| (*arg).to_string()).collect();
    args.push(package.package.clone());
    args.extend(package.args.clone());
    let mut env = package.env.clone();
    prepend_executable_path(&mut env, &executable);
    Ok(InstalledAcpAgent {
        id: entry.id.clone(),
        name: entry.name.clone(),
        version: entry.version.clone(),
        command: launch_json(&executable, &args, &env)?,
        distribution: runner.into(),
    })
}

fn launch_json(
    command: &Path,
    args: &[String],
    env: &BTreeMap<String, String>,
) -> anyhow::Result<String> {
    Ok(serde_json::to_string(&LaunchConfig { command, args, env })?)
}

fn find_executable(name: &str) -> Option<PathBuf> {
    let mut search_dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    if let Some(home) = home {
        search_dirs.extend([
            home.join(".local").join("bin"),
            home.join(".volta").join("bin"),
            home.join(".bun").join("bin"),
            home.join(".local")
                .join("share")
                .join("fnm")
                .join("aliases")
                .join("default")
                .join("bin"),
            home.join(".fnm")
                .join("aliases")
                .join("default")
                .join("bin"),
        ]);
        if cfg!(windows) {
            if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
                search_dirs.push(appdata.join("npm"));
            }
            search_dirs.extend([
                home.join("AppData").join("Local").join("fnm").join("aliases").join("default").join("bin"),
                home.join("AppData").join("Local").join("Volta"),
                home.join("AppData").join("Local").join("pnpm"),
            ]);
        }
        let nvm = home.join(".nvm").join("versions").join("node");
        if let Ok(entries) = std::fs::read_dir(nvm) {
            let mut versions: Vec<PathBuf> = entries
                .flatten()
                .map(|entry| entry.path().join("bin"))
                .collect();
            versions.sort();
            versions.reverse();
            search_dirs.extend(versions);
        }
    }
    search_dirs.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);

    let extensions = if cfg!(windows) {
        let mut exts = vec!["".to_string()];
        if let Some(pathext) = std::env::var_os("PATHEXT") {
            for ext in std::env::split_paths(&pathext) {
                let ext_str = ext.to_string_lossy().to_string();
                if !ext_str.is_empty() {
                    if ext_str.starts_with('.') {
                        exts.push(ext_str);
                    } else {
                        exts.push(format!(".{ext_str}"));
                    }
                }
            }
        }
        if exts.len() == 1 {
            exts.extend([
                ".exe".to_string(),
                ".cmd".to_string(),
                ".bat".to_string(),
                ".ps1".to_string(),
            ]);
        }
        exts
    } else {
        vec!["".to_string()]
    };

    for dir in search_dirs {
        for ext in &extensions {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn prepend_executable_path(env: &mut BTreeMap<String, String>, executable: &Path) {
    let Some(parent) = executable.parent() else {
        return;
    };
    let mut paths = vec![parent.to_path_buf()];
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path));
    }
    if let Ok(path) = std::env::join_paths(paths) {
        env.insert("PATH".into(), path.to_string_lossy().to_string());
    }
}

fn install_archive(
    root: &Path,
    version_dir: &Path,
    url: &str,
    command: &str,
    bytes: &[u8],
) -> anyhow::Result<PathBuf> {
    if version_dir.exists() {
        let executable = executable_path(version_dir, command)?;
        if executable.is_file() {
            return validated_executable(version_dir, executable);
        }
    }
    std::fs::create_dir_all(root)?;
    let temp = tempfile::Builder::new()
        .prefix(".install-")
        .tempdir_in(root)?;
    let lower = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
    if lower.ends_with(".zip") {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
        for index in 0..archive.len() {
            let mut file = archive.by_index(index)?;
            let Some(relative) = file.enclosed_name() else {
                continue;
            };
            let output = temp.path().join(relative);
            if file.is_dir() {
                std::fs::create_dir_all(&output)?;
            } else {
                if let Some(parent) = output.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut destination = std::fs::File::create(&output)?;
                std::io::copy(&mut file, &mut destination)?;
                #[cfg(unix)]
                if let Some(mode) = file.unix_mode() {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&output, std::fs::Permissions::from_mode(mode))?;
                }
            }
        }
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        tar::Archive::new(flate2::read::GzDecoder::new(Cursor::new(bytes))).unpack(temp.path())?;
    } else if lower.ends_with(".tar.bz2") || lower.ends_with(".tbz2") {
        tar::Archive::new(bzip2::read::BzDecoder::new(Cursor::new(bytes))).unpack(temp.path())?;
    } else {
        let output = executable_path(temp.path(), command)?;
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&output, bytes)?;
    }
    let executable = executable_path(temp.path(), command)?;
    if !executable.is_file() {
        bail!("registry command was not found in the downloaded archive: {command}");
    }
    validated_executable(temp.path(), executable.clone())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&executable)?.permissions();
        permissions.set_mode(permissions.mode() | 0o700);
        std::fs::set_permissions(&executable, permissions)?;
    }
    if version_dir.exists() {
        std::fs::remove_dir_all(version_dir)?;
    }
    let temp_path = temp.keep();
    std::fs::rename(&temp_path, version_dir)?;
    executable_path(version_dir, command)
}

fn executable_path(root: &Path, command: &str) -> anyhow::Result<PathBuf> {
    let relative = command
        .trim_start_matches("./")
        .replace('\\', std::path::MAIN_SEPARATOR_STR);
    let relative = Path::new(&relative);
    if relative.components().any(|component| {
        !matches!(
            component,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    }) {
        bail!("invalid ACP registry command path");
    }
    Ok(root.join(relative))
}

fn validated_executable(root: &Path, executable: PathBuf) -> anyhow::Result<PathBuf> {
    let canonical_root = root.canonicalize()?;
    let canonical_executable = executable.canonicalize()?;
    if !canonical_executable.starts_with(canonical_root) {
        bail!("ACP registry command resolves outside its install directory");
    }
    Ok(executable)
}

fn safe_component(value: &str) -> String {
    let component: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect();
    if component.is_empty() || matches!(component.as_str(), "." | "..") {
        "_".into()
    } else {
        component
    }
}

fn platform_target() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-aarch64",
        ("macos", "x86_64") => "darwin-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        ("linux", "x86_64") => "linux-x86_64",
        ("windows", "aarch64") => "windows-aarch64",
        ("windows", "x86_64") => "windows-x86_64",
        _ => "unsupported",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_snapshot_marks_platform_binary_supported() {
        let config = AcpConfig::default();
        let entries = vec![RegistryEntry {
            id: "agent".into(),
            name: "Agent".into(),
            version: "1.0.0".into(),
            description: "Test".into(),
            repository: None,
            website: None,
            distribution: RegistryDistribution {
                binary: BTreeMap::from([(
                    platform_target().to_string(),
                    BinaryDistribution {
                        archive: "https://example.test/agent.zip".into(),
                        sha256: None,
                        cmd: "./agent".into(),
                        args: vec![],
                        env: BTreeMap::new(),
                    },
                )]),
                uvx: Some(PackageDistribution {
                    package: "agent-package".into(),
                    args: vec![],
                    env: BTreeMap::new(),
                }),
                ..Default::default()
            },
        }];
        let snapshot = snapshot(config, entries, None);
        assert!(snapshot.registry[0].supported);
        assert_eq!(snapshot.registry[0].distribution.as_deref(), Some("binary"));
    }

    #[test]
    fn executable_path_cannot_escape_install_root() {
        let root = Path::new("/tmp/agent");
        assert!(executable_path(root, "../../bin/sh").is_err());
        assert_eq!(safe_component(".."), "_");
    }

    #[test]
    fn extracts_direct_executable_from_npx_package_spec() {
        assert_eq!(npx_executable_name("droid@0.186.0"), Some("droid"));
        assert_eq!(
            npx_executable_name("@augmentcode/auggie@0.34.0"),
            Some("auggie")
        );
        assert_eq!(npx_executable_name("invalid/package/name"), None);
        assert_eq!(npx_executable_name("droid@npm:other"), Some("droid"));
        assert_eq!(npx_executable_name("https://example.test/a"), None);
    }

    #[test]
    fn direct_package_agent_skips_npx_package_argument() {
        let entry = RegistryEntry {
            id: "factory-droid".into(),
            name: "Factory Droid".into(),
            version: "0.186.0".into(),
            description: String::new(),
            repository: None,
            website: None,
            distribution: RegistryDistribution::default(),
        };
        let package = PackageDistribution {
            package: "droid@0.186.0".into(),
            args: vec!["exec".into(), "--output-format".into(), "acp-daemon".into()],
            env: BTreeMap::from([("DROID_DISABLE_AUTO_UPDATE".into(), "true".into())]),
        };
        let installed =
            direct_package_agent(&entry, &package, PathBuf::from("/usr/local/bin/droid")).unwrap();
        let launch: serde_json::Value = serde_json::from_str(&installed.command).unwrap();

        assert_eq!(installed.distribution, "direct");
        assert_eq!(launch["command"], "/usr/local/bin/droid");
        assert_eq!(
            launch["args"],
            serde_json::json!(["exec", "--output-format", "acp-daemon"])
        );
        assert_eq!(launch["env"]["DROID_DISABLE_AUTO_UPDATE"], "true");
    }

    #[test]
    fn config_round_trips() {
        let temp = tempfile::tempdir().unwrap();
        let agents = AcpAgents::new(temp.path());
        let config = AcpConfig {
            active_agent_id: Some("a".into()),
            agents: vec![InstalledAcpAgent {
                id: "a".into(),
                name: "Agent".into(),
                version: "1".into(),
                command: "{}".into(),
                distribution: "npx".into(),
            }],
        };
        agents.save_config(&config).unwrap();
        assert_eq!(
            agents.load_config().unwrap().active_agent_id.as_deref(),
            Some("a")
        );
    }
}
