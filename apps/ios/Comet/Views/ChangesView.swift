import SwiftUI

struct ChangesView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let chat: Chat
    @State private var status: GitStatus?
    @State private var loading = true

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView("Loading changes…")
                } else if let status, status.isRepo {
                    List {
                        Section {
                            HStack {
                                Image(systemName: "arrow.triangle.branch")
                                Text(status.branch ?? "Detached HEAD")
                                Spacer()
                                if status.ahead > 0 { Text("↑\(status.ahead)") }
                                if status.behind > 0 { Text("↓\(status.behind)") }
                            }
                        }
                        if status.files.isEmpty {
                            Text("Working tree clean")
                                .foregroundStyle(Theme.textMuted)
                        } else {
                            Section("Files") {
                                ForEach(status.files) { file in
                                    HStack(spacing: 10) {
                                        Text(marker(for: file))
                                            .font(.system(.body, design: .monospaced))
                                            .foregroundStyle(color(for: file))
                                            .frame(width: 18)
                                        VStack(alignment: .leading) {
                                            Text(file.path)
                                                .lineLimit(1)
                                                .truncationMode(.middle)
                                            Text(file.label)
                                                .font(.caption)
                                                .foregroundStyle(Theme.textMuted)
                                        }
                                        Spacer()
                                    }
                                }
                            }
                        }
                    }
                    .scrollContentBackground(.hidden)
                } else {
                    ContentUnavailableView("Not a Git repository",
                                           systemImage: "folder",
                                           description: Text(chat.cwd ?? ""))
                }
            }
            .background(Theme.surface)
            .navigationTitle("Changes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                status = await model.gitStatus(chat: chat)
                loading = false
            }
        }
        .preferredColorScheme(.dark)
    }

    private func marker(for file: GitFileChange) -> String {
        switch file.kind {
        case "added", "untracked": return "+"
        case "deleted": return "-"
        case "renamed": return "→"
        default: return "·"
        }
    }

    private func color(for file: GitFileChange) -> Color {
        switch file.kind {
        case "added", "untracked": return Theme.statusCompleted
        case "deleted": return Theme.danger
        default: return Theme.textMuted
        }
    }
}
