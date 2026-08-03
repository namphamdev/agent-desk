// Settings sheet for notification toggles.
//
// Wraps NotificationManager's @AppStorage settings in a Form, matching the
// style of DeviceSettingsView. When the user tries to enable notifications
// but permission was denied, the sheet shows a "Open Settings" button.

import SwiftUI

struct NotificationSettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Task complete", isOn: Binding(
                        get: { model.notifications.taskDoneEnabled },
                        set: { model.notifications.taskDoneEnabled = $0 }
                    ))
                    Toggle("Input needed", isOn: Binding(
                        get: { model.notifications.inputNeededEnabled },
                        set: { model.notifications.inputNeededEnabled = $0 }
                    ))
                } header: {
                    Text("Notifications")
                } footer: {
                    Text("Get a push notification when an agent finishes its work or needs your response.")
                }

                Section {
                    HStack {
                        Text("Permission")
                        Spacer()
                        Text(statusLabel)
                            .foregroundStyle(model.notifications.canSendNotifications ? Theme.textMuted : Theme.warning)
                    }
                    if !model.notifications.canSendNotifications {
                        Button("Open Settings") {
                            model.notifications.openSystemSettings()
                        }
                    }
                } header: {
                    Text("System")
                } footer: {
                    Text("Notifications are delivered by iOS. If denied, Comet cannot send alerts.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.surface)
            .navigationTitle("Notifications")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await model.notifications.refreshAuthStatus() }
        }
        .preferredColorScheme(.dark)
    }

    private var statusLabel: String {
        switch model.notifications.authorizationStatus {
        case .authorized: return "Allowed"
        case .denied: return "Denied"
        case .notDetermined: return "Not asked yet"
        case .provisional: return "Provisional"
        case .ephemeral: return "Ephemeral"
        @unknown default: return "Unknown"
        }
    }
}
