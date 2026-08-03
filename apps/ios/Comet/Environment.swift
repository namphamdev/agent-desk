import Foundation

enum AppEnvironment {
    static let edgeURL = URL(string: CometBuildEnvironment.edgeURL)!
    static let workosClientId = CometBuildEnvironment.workosClientId
}
