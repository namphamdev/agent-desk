import SwiftUI

struct DeviceSettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var deviceId: String?
    @State private var acp: AcpAgentsSnapshot?
    @State private var providers: CustomProviderSnapshot?
    @State private var showProviderEditor = false
    @State private var editingProvider: CustomProvider?
    @State private var error: String?

    private var devices: [DeviceRow] {
        (model.demo?.devices ?? model.workspace?.devices ?? []).filter { $0.platform != "ios" }
    }

    private var selectedDevice: String? {
        deviceId ?? devices.first?.id
    }

    var body: some View {
        NavigationStack {
            List {
                if devices.isEmpty {
                    Text("No desktop devices connected.")
                        .foregroundStyle(Theme.textMuted)
                } else {
                    Section("Device") {
                        Picker("Runs sessions on", selection: Binding(
                            get: { selectedDevice ?? "" },
                            set: { deviceId = $0 }
                        )) {
                            ForEach(devices) { device in
                                Text(device.name).tag(device.id)
                            }
                        }
                    }

                    acpSection
                    providersSection
                }
                if let error {
                    Text(error).foregroundStyle(Theme.danger)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.surface)
            .navigationTitle("Device settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task(id: selectedDevice) {
                await reload()
            }
            .sheet(isPresented: $showProviderEditor) {
                ProviderEditorSheet(provider: editingProvider) { draft in
                    guard let selectedDevice else { return }
                    Task {
                        providers = await model.upsertCustomProvider(deviceId: selectedDevice, provider: draft)
                        showProviderEditor = false
                    }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private var acpSection: some View {
        Section("ACP agents") {
            if let acp {
                if acp.installed.isEmpty {
                    Text("No ACP agents installed.")
                        .foregroundStyle(Theme.textMuted)
                }
                ForEach(acp.installed) { agent in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(agent.name)
                            Text("v\(agent.version) · \(agent.distribution)")
                                .font(.caption)
                                .foregroundStyle(Theme.textMuted)
                        }
                        Spacer()
                        if acp.activeAgentId == agent.id {
                            Text("Active").font(.caption).foregroundStyle(Theme.accent)
                        } else {
                            Button("Use") { acpAction("ActivateAcpAgent", agent.id) }
                        }
                        Button("Remove", role: .destructive) { acpAction("RemoveAcpAgent", agent.id) }
                    }
                }
                ForEach(acp.registry.filter { registry in
                    !acp.installed.contains { $0.id == registry.id }
                }) { agent in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(agent.name)
                            Text(agent.description).font(.caption).foregroundStyle(Theme.textMuted)
                        }
                        Spacer()
                        Button(agent.supported ? "Add" : "Unavailable") {
                            acpAction("InstallAcpAgent", agent.id)
                        }
                        .disabled(!agent.supported)
                    }
                }
            } else {
                ProgressView()
            }
        }
    }

    private var providersSection: some View {
        Section("Custom providers") {
            if let providers {
                ForEach(providers.providers) { provider in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(provider.name)
                            Text(provider.baseUrl).font(.caption).foregroundStyle(Theme.textMuted)
                        }
                        Spacer()
                        ForEach(["claude-code", "codex"], id: \.self) { harness in
                            Button(providers.selection[harness] == provider.id ? "Selected" : harness == "codex" ? "Use Codex" : "Use Claude") {
                                Task {
                                    self.providers = await model.selectCustomProvider(
                                        deviceId: selectedDevice ?? "", harness: harness, providerId: provider.id
                                    )
                                }
                            }
                            .font(.caption)
                        }
                        Button { editingProvider = provider; showProviderEditor = true } label: {
                            Image(systemName: "pencil")
                        }
                        .accessibilityLabel("Edit \(provider.name)")
                        Button(role: .destructive) {
                            Task {
                                self.providers = await model.deleteCustomProvider(
                                    deviceId: selectedDevice ?? "", providerId: provider.id
                                )
                            }
                        } label: {
                            Image(systemName: "trash")
                        }
                        .accessibilityLabel("Delete \(provider.name)")
                    }
                }
                Button("Add custom provider") {
                    editingProvider = nil
                    showProviderEditor = true
                }
            } else {
                ProgressView()
            }
        }
    }

    private func reload() async {
        guard let selectedDevice else { return }
        acp = await model.acpAgents(deviceId: selectedDevice)
        providers = await model.customProviders(deviceId: selectedDevice)
    }

    private func acpAction(_ method: String, _ agentId: String) {
        guard let selectedDevice else { return }
        Task {
            acp = await model.acpAgentAction(deviceId: selectedDevice, method: method, agentId: agentId)
        }
    }
}

struct ProviderEditorSheet: View {
    @Environment(\.dismiss) private var dismiss
    let provider: CustomProvider?
    let onSave: (CustomProviderDraft) -> Void
    @State private var name = ""
    @State private var baseUrl = ""
    @State private var apiKey = ""
    @State private var format = "anthropic"

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name)
                TextField("Base URL", text: $baseUrl)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                SecureField(provider == nil ? "API key" : "Replace API key", text: $apiKey)
                Picker("Format", selection: $format) {
                    Text("Anthropic").tag("anthropic")
                    Text("OpenAI Responses").tag("responses")
                }
            }
            .navigationTitle(provider == nil ? "Add provider" : "Edit provider")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(CustomProviderDraft(
                            id: provider?.id ?? UUID().uuidString.lowercased(),
                            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                            baseUrl: baseUrl.trimmingCharacters(in: .whitespacesAndNewlines),
                            apiKey: apiKey.isEmpty ? nil : apiKey,
                            formats: [format]
                        ))
                    }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                              baseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear {
                name = provider?.name ?? ""
                baseUrl = provider?.baseUrl ?? ""
                format = provider?.formats.first ?? "anthropic"
            }
        }
        .presentationDetents([.medium])
    }
}
