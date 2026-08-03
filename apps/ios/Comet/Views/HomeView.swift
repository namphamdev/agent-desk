// Home — the mobile shell. The desktop sidebar's two sections become the
// phone's home screen: Spaces (grouped work) and Sessions (the global
// attention-sorted list). Tabs-as-sessions don't fit a phone; a space opens
// into its own session list instead, and close=archive becomes swipe-to-archive.

import SwiftUI

enum Route: Hashable {
    case space(String)
    case chat(String)
    case activity
    case newSession(spaceId: String)
}

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var path: [Route] = []
    @State private var showNewSpace = false
    @State private var showDeviceSettings = false
    @State private var showNotificationSettings = false

    var body: some View {
        NavigationStack(path: $path) {
            List {
                spacesSection
                sessionsSection
            }
            .listStyle(.plain)
            .environment(\.defaultMinListRowHeight, 10)
            .contentMargins(.top, 2, for: .scrollContent)
            .scrollContentBackground(.hidden)
            .background(Theme.surface.ignoresSafeArea())
            .navigationTitle("Comet")  // feeds the back menu; not displayed
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .space(let id): SpaceView(spaceId: id, path: $path)
                case .chat(let id): SessionView(chatId: id)
                case .activity: ActivityView(path: $path)
                case .newSession(let spaceId): NewSessionView(spaceId: spaceId, path: $path)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    // In the bar, not the list: as a list row it appeared and
                    // vanished with the connection and shoved the content down.
                    if !model.connected {
                        ProgressView()
                            .controlSize(.mini)
                            .tint(Theme.textMuted)
                            .accessibilityLabel("Connecting")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        path.append(.activity)
                    } label: {
                        Image(systemName: "bell")
                            .overlay(alignment: .topTrailing) {
                                if model.activityChats.contains(where: { $0.unseen && model.indicator(for: $0) == .completed }) {
                                    Circle()
                                        .fill(Theme.accent)
                                        .frame(width: 6, height: 6)
                                        .offset(x: 3, y: -2)
                                }
                            }
                    }
                    .accessibilityLabel("Activity")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showNewSpace = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("New space")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if model.demo != nil {
                            Text("Demo mode")
                        }
                            Button("ACP and providers") {
                                showDeviceSettings = true
                            }
                        Button {
                            showNotificationSettings = true
                        } label: {
                            if model.notifications.canSendNotifications {
                                Label("Notifications", systemImage: "bell.fill")
                            } else {
                                Label("Notifications", systemImage: "bell.slash")
                            }
                        }
                        Button("Sign out", role: .destructive) { model.signOut() }
                    } label: {
                        Image(systemName: "person.circle")
                    }
                }
            }
            .sheet(isPresented: $showNewSpace) {
                NewSpaceSheet { spaceId in
                    path.append(.space(spaceId))
                }
            }
            .sheet(isPresented: $showDeviceSettings) {
                DeviceSettingsView()
            }
            .sheet(isPresented: $showNotificationSettings) {
                NotificationSettingsView()
            }
            .task(id: model.overviewChats.map(\.id).joined()) {
                model.preloadSessions()
                model.scanSessionStatuses()
            }
            .task(id: model.sessionStatusFingerprint) {
                model.scanSessionStatuses()
            }
            .onAppear {
                if let route = model.launchRoute {
                    model.launchRoute = nil
                    // Push the whole stack atomically — appending from a child's
                    // onAppear mid-transition gets dropped by NavigationStack.
                    if case .space(let id) = route, model.launchSheet == "newsession" {
                        model.launchSheet = nil
                        path = [route, .newSession(spaceId: id)]
                    } else {
                        path = [route]
                    }
                }
                if model.launchSheet == "newspace" {
                    model.launchSheet = nil
                    showNewSpace = true
                }
            }
        }
    }

    // MARK: Spaces

    private var spacesSection: some View {
        Section {
            if model.spaces.isEmpty {
                Text("No spaces yet — add one from a desktop device")
                    .font(Theme.sans(12))
                    .foregroundStyle(Theme.textFaint)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            ForEach(model.spaces) { space in
                Button {
                    path.append(.space(space.id))
                } label: {
                    SpaceRow(space: space)
                }
                .buttonStyle(PressWashButtonStyle())
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 2, leading: 12, bottom: 2, trailing: 12))
            }
        } header: {
            sectionHeader("Spaces")
        }
    }

    // MARK: Sessions

    private var sessionsSection: some View {
        Section {
            let chats = model.overviewChats
            if chats.isEmpty {
                Text("No sessions yet")
                    .font(Theme.sans(12))
                    .foregroundStyle(Theme.textFaint)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            ForEach(chats) { chat in
                Button {
                    path.append(.chat(chat.id))
                } label: {
                    ChatRow(chat: chat, showLocation: true)
                }
                .buttonStyle(PressWashButtonStyle())
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 1, leading: 12, bottom: 1, trailing: 12))
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button {
                        model.archive(chatId: chat.id)
                    } label: {
                        Label("Archive", systemImage: "archivebox")
                    }
                    .tint(Theme.surfaceRaised)
                }
            }
            .motionAnimation(Motion.resort, value: chats.map(\.id))
        } header: {
            sectionHeader("Sessions")
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(Theme.sans(11, weight: .medium))
            .foregroundStyle(Theme.textMuted.opacity(0.6))
            .textCase(nil)
            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 3, trailing: 16))
    }
}

// MARK: - Activity

struct ActivityView: View {
    @Environment(AppModel.self) private var model
    @Binding var path: [Route]
    @State private var showDone = false

    private var active: [Chat] {
        model.activityChats.filter { $0.settledAt == nil }
    }

    private var done: [Chat] {
        model.activityChats.filter { $0.settledAt != nil }
    }

    var body: some View {
        List {
            activitySection("Needs attention", chats: active.filter {
                let indicator = model.indicator(for: $0)
                return indicator == .awaitingInput || indicator == .errored
            })
            activitySection("Completed", chats: active.filter {
                model.indicator(for: $0) == .completed
            })
            activitySection("Running", chats: active.filter {
                model.indicator(for: $0) == .working
            })
            activitySection("Seen", chats: active.filter {
                model.indicator(for: $0) == .idle
            })

            if !done.isEmpty {
                Section {
                    if showDone {
                        ForEach(done) { chat in
                            activityRow(chat, dimmed: true)
                        }
                    }
                } header: {
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            showDone.toggle()
                        }
                    } label: {
                        HStack {
                            Text("Done")
                            Spacer()
                            Text("\(done.count)")
                                .foregroundStyle(Theme.textFaint)
                            Image(systemName: showDone ? "chevron.down" : "chevron.right")
                        }
                    }
                    .font(Theme.sans(11, weight: .medium))
                    .foregroundStyle(Theme.textMuted.opacity(0.7))
                    .textCase(nil)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.surface.ignoresSafeArea())
        .navigationTitle("Activity")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Mark all as read") {
                        model.markAllActivityRead()
                    }
                } label: {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                }
                .accessibilityLabel("Activity filters")
            }
        }
    }

    @ViewBuilder
    private func activitySection(_ title: String, chats: [Chat]) -> some View {
        if !chats.isEmpty {
            Section {
                ForEach(chats) { chat in
                    activityRow(chat)
                }
            } header: {
                Text(title)
                    .font(Theme.sans(11, weight: .medium))
                    .foregroundStyle(Theme.textMuted.opacity(0.6))
                    .textCase(nil)
            }
        }
    }

    private func activityRow(_ chat: Chat, dimmed: Bool = false) -> some View {
        Button {
            model.markSeen(chatId: chat.id)
            path.append(.chat(chat.id))
        } label: {
            ActivityRow(chat: chat, dimmed: dimmed)
        }
        .buttonStyle(PressWashButtonStyle())
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button {
                model.setSettled(chatId: chat.id, settled: chat.settledAt == nil)
            } label: {
                Label(chat.settledAt == nil ? "Done" : "Undo", systemImage: chat.settledAt == nil ? "checkmark" : "arrow.uturn.backward")
            }
            .tint(Theme.surfaceRaised)
        }
    }
}

private struct ActivityRow: View {
    @Environment(AppModel.self) private var model
    let chat: Chat
    var dimmed: Bool

    var body: some View {
        let indicator = model.indicator(for: chat)
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                StatusRail(indicator: indicator)
                if let harness = chat.config?.harness {
                    HarnessBadge(harness: harness, size: 12, dimmed: dimmed, neutral: Theme.textMuted)
                }
                Text(chat.displayTitle)
                    .font(Theme.sans(13, weight: .medium))
                    .foregroundStyle(dimmed ? Theme.textMuted : Theme.text)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if chat.unseen {
                    Circle().fill(Theme.accent).frame(width: 5, height: 5)
                }
            }
            HStack(spacing: 5) {
                Text(model.space(for: chat)?.displayName ?? "Unknown project")
                if let branch = chat.branch, !branch.isEmpty {
                    Text("·")
                    Text(branch)
                }
                Spacer(minLength: 0)
                Text(indicator.activityLabel)
            }
            .font(Theme.sans(11))
            .foregroundStyle(dimmed ? Theme.textFaint : Theme.textMuted.opacity(0.65))
            .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .opacity(dimmed ? 0.65 : 1)
        .contentShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - Rows

struct SpaceRow: View {
    @Environment(AppModel.self) private var model
    let space: Space

    var body: some View {
        HStack(spacing: 8) {
            // Leading 6pt aggregate dot — position stable, most-urgent member.
            let agg = model.spaceIndicator(space.id)
            Circle()
                .fill((agg == .working || agg == .awaitingInput) ? (agg?.dotColor ?? whiteAlpha(0.14)) : whiteAlpha(0.14))
                .frame(width: 6, height: 6)
            Image(systemName: "folder")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textMuted)
            Text(space.displayName)
                .font(Theme.sans(13, weight: .medium))
                .foregroundStyle(Theme.text)
                .lineLimit(1)
            Spacer(minLength: 8)
            deviceTag
            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Theme.textFaint.opacity(0.6))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        .contentShape(RoundedRectangle(cornerRadius: 8))
    }

    private var deviceTag: some View {
        let online = model.deviceOnline(space.deviceId)
        let name = model.deviceName(space.deviceId)
        return Text(online ? "@ \(name)" : "@ \(name) · offline")
            .font(Theme.sans(12))
            .foregroundStyle(online ? Theme.textMuted.opacity(0.6) : Theme.warning.opacity(0.8))
            .lineLimit(1)
    }
}

/// The desktop session row (shell.rs `render_chat_row`), line for line: the
/// status rail leads a muted context line carrying the space name and the
/// relative time; the title sits on its own line below; harness mark and branch
/// close it out. Lines 2 and 3 indent by rail + gap so they start exactly under
/// the context line rather than beside the rail.
///
/// The one addition the phone needs: the desktop row names only the space
/// because its sidebar sits on the machine running the work. Here the Sessions
/// list interleaves every device, and a session whose host has gone offline
/// can't be driven at all — so the context line reads "space · device".
struct ChatRow: View {
    @Environment(AppModel.self) private var model
    let chat: Chat
    var showLocation: Bool

    /// Rail (6) + gap (8) — see `render_chat_row`'s `pl(px(14.0))`.
    private static let indent: CGFloat = StatusRail.width + 8

    private var subline: Color { Theme.textMuted.opacity(0.5) }

    var body: some View {
        let indicator = model.indicator(for: chat)
        VStack(alignment: .leading, spacing: 2) {
            // Line 1: status rail, space · device, time-ago.
            HStack(spacing: 8) {
                StatusRail(indicator: indicator)
                if showLocation {
                    Text(location)
                        .font(Theme.sans(11))
                        .foregroundStyle(subline)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Spacer(minLength: 4)
                }
                Text(relativeTime(chat.lastMessageAt ?? chat.createdAt))
                    .font(Theme.sans(11))
                    .foregroundStyle(subline)
                    .fixedSize()
            }

            // Line 2: the session title.
            Text(chat.displayTitle)
                .font(Theme.sans(13))
                .foregroundStyle(Theme.text)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, Self.indent)

            // Line 3: harness brand mark, then the branch when the engine
            // stamped one.
            HStack(spacing: 4) {
                if let harness = chat.config?.harness {
                    HarnessBadge(harness: harness, size: 11, neutral: subline)
                }
                if let branch = chat.branch?.trimmingCharacters(in: .whitespaces), !branch.isEmpty {
                    LineIconView(.gitBranch, size: 11, color: subline)
                    Text(branch)
                        .font(Theme.sans(11))
                        .foregroundStyle(subline)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 0)
            }
            .padding(.leading, Self.indent)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .contentShape(RoundedRectangle(cornerRadius: 8))
    }

    /// "space · device", with offline marker. The space name (not the cwd
    /// basename) is what the desktop row shows — they differ once a space has
    /// been renamed, or when the session runs in a worktree off to the side.
    private var location: String {
        let space = model.space(for: chat)?.displayName
            ?? chat.cwd.map { ($0 as NSString).lastPathComponent }
            ?? "?"
        let name = model.deviceName(chat.deviceId)
        return model.deviceOnline(chat.deviceId)
            ? "\(space) · \(name)"
            : "\(space) · \(name) (offline)"
    }
}

func relativeTime(_ ms: Int64) -> String {
    let delta = max(0, nowMs() - ms) / 1000
    if delta < 60 { return "now" }
    if delta < 3600 { return "\(delta / 60)m" }
    if delta < 86_400 { return "\(delta / 3600)h" }
    return "\(delta / 86_400)d"
}
