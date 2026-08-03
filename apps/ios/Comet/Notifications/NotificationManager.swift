// Local push notifications for agent task lifecycle events.
//
// Mirrors the desktop's `notify.rs`: fires a local notification when the agent
// finishes a task (Working → Idle/Completed) or asks for input (→ AwaitingInput).
// The phone is a viewport device — it never hosts the engine — so this is the
// ONLY signal path while the app is backgrounded or the user is in another
// session.
//
// Permission is requested lazily on first connection (or when the user enables
// notifications in settings). The kill-switches live in UserDefaults so they
// survive relaunches:
//   - `notifyTaskDone`     — fires when a run finishes.
//   - `notifyInputNeeded`  — fires when the agent is waiting on a question.
//
// Foreground notifications are suppressed when the active session IS the source
// (the user is already watching) and handled by the delegate otherwise.

import Foundation
import UIKit
import UserNotifications
import Observation

@MainActor
@Observable
final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()

    // MARK: - Persisted settings (UserDefaults-backed for @Observable)

    private static let taskDoneKey = "notifyTaskDone"
    private static let inputNeededKey = "notifyInputNeeded"

    var taskDoneEnabled: Bool {
        get {
            if UserDefaults.standard.object(forKey: Self.taskDoneKey) == nil { return true }
            return UserDefaults.standard.bool(forKey: Self.taskDoneKey)
        }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.taskDoneKey)
        }
    }

    var inputNeededEnabled: Bool {
        get {
            if UserDefaults.standard.object(forKey: Self.inputNeededKey) == nil { return true }
            return UserDefaults.standard.bool(forKey: Self.inputNeededKey)
        }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.inputNeededKey)
        }
    }

    /// The chat the user is currently viewing — notifications from this chat
    /// are suppressed in the foreground (the user is already watching it).
    var activeChatId: String? {
        didSet { activeChatIdSnapshot = activeChatId }
    }

    /// Snapshot of `activeChatId` accessible from the nonisolated delegate.
    /// Written on the main actor alongside `activeChatId`.
    @ObservationIgnored nonisolated(unsafe) private var activeChatIdSnapshot: String?

    /// The last status we observed per chat, so we only fire on transitions
    /// (not every projection tick). Storing the raw value avoids a reference
    /// cycle with SessionRow.
    @ObservationIgnored private var lastStatus: [String: String] = [:]  // chatId → SessionStatus.rawValue

    /// Has the user granted (or denied) notification permission.
    private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined

    private override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
        Task { await refreshAuthStatus() }
    }

    // MARK: - Permission

    func refreshAuthStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorizationStatus = settings.authorizationStatus
    }

    /// Ask for permission (no-op if already determined). Called on first
    /// connection or when the user toggles notifications on in settings.
    func requestPermissionIfNeeded() async {
        guard authorizationStatus == .notDetermined else { return }
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            authorizationStatus = granted ? .authorized : .denied
        } catch {
            authorizationStatus = .denied
        }
    }

    /// Open system Settings if the user denied permission but wants to enable
    /// notifications.
    func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    var canSendNotifications: Bool {
        authorizationStatus == .authorized || authorizationStatus == .provisional
    }

    // MARK: - Status observer

    /// Called by AppModel on every workspace/demo session projection. Fires a
    /// notification only when a session transitions INTO a trigger state.
    ///
    /// - Working → Idle (task done): fires `notifyTaskDone` (if enabled).
    /// - * → AwaitingInput: fires `notifyInputNeeded` (if enabled).
    /// - Working → Errored: fires `notifyTaskDone` with an error body.
    ///
    /// We track the **raw doc status** (not the staleness-filtered effective
    /// status) so a long-running task (> 45s) that eventually completes still
    /// shows the transition correctly: the stale filter turns `.working` into
    /// `nil` in the effective view, which would erase our "previous = working"
    /// baseline and miss the transition.
    ///
    /// Suppressed when:
    ///   - notifications are disabled entirely;
    ///   - the status didn't actually change;
    ///   - the new status is stale (the host crashed, not finished).
    func observeStatus(
        chatId: String,
        rawStatus: SessionStatus?,
        updatedAt: Int64?,
        now: Int64,
        chatTitle: String?
    ) {
        let newValue = rawStatus?.rawValue
        let previous = lastStatus[chatId]
        lastStatus[chatId] = newValue

        guard let rawStatus else { return }
        // Only fire on a transition — if we had no prior state, the app just
        // launched and the user hasn't been "watching" anything yet, so don't
        // notify for pre-existing statuses.
        guard let previous else { return }
        guard previous != newValue else { return }

        // Staleness check: a Working/AwaitingInput row whose updatedAt is older
        // than sessionStaleMs means the host likely crashed — don't notify.
        // But Idle/Errored statuses are always fresh (they're terminal).
        if let updatedAt {
            switch rawStatus {
            case .working, .awaitingInput:
                let age = now - updatedAt
                if age > sessionStaleMs { return }
            case .idle, .errored:
                break
            }
        }

        switch rawStatus {
        case .idle:
            // Working → Idle means the run finished.
            guard previous == SessionStatus.working.rawValue else { return }
            guard taskDoneEnabled else { return }
            fire(
                identifier: "done-\(chatId)-\(nowMs())",
                title: "Task complete",
                body: chatTitle.map { "\($0) finished its work." } ?? "The agent finished its work.",
                chatId: chatId
            )
        case .awaitingInput:
            guard inputNeededEnabled else { return }
            fire(
                identifier: "input-\(chatId)-\(nowMs())",
                title: "Input needed",
                body: chatTitle.map { "\($0) is waiting for your response." } ?? "The agent is waiting for your response.",
                chatId: chatId
            )
        case .errored:
            guard previous == SessionStatus.working.rawValue else { return }
            guard taskDoneEnabled else { return }
            fire(
                identifier: "error-\(chatId)-\(nowMs())",
                title: "Task failed",
                body: chatTitle.map { "\($0) ran into an error." } ?? "The agent encountered an error.",
                chatId: chatId
            )
        case .working:
            // Entering working state is not a notification trigger.
            break
        }
    }

    /// Clear all pending/delivered notifications (called on sign-out).
    func clearAll() {
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        lastStatus.removeAll()
    }

    // MARK: - Fire

    private func fire(identifier: String, title: String, body: String, chatId: String) {
        guard canSendNotifications else { return }

        // Queue the request regardless of foreground state. The delegate
        // (userNotificationCenter(_:willPresent:)) decides whether to show a
        // banner based on whether the user is actively viewing this chat.
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.userInfo = ["chatId": chatId]

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 0.1, repeats: false)
        let request = UNNotificationRequest(
            identifier: identifier,
            content: content,
            trigger: trigger
        )

        Task.detached {
            do {
                try await UNUserNotificationCenter.current().add(request)
            } catch {
                // Swallow — a failed notification must never disturb the session.
            }
        }
    }

    // MARK: - Foreground display

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let chatId = notification.request.content.userInfo["chatId"] as? String
        // Suppress the banner if the user is actively viewing this chat — they
        // already see the result. Show it otherwise so foregrounded sessions
        // still surface completions from other sessions.
        if activeChatIdSnapshot == chatId {
            completionHandler([])
            return
        }
        completionHandler([.banner, .sound])
    }
}
