import Foundation

/// A model the app downloaded into `<models dir>/<id>/`, as described by its `manifest.json`.
struct DownloadedModel: Decodable, Sendable {
    let id: String
    let name: String
    let task: String
    let engine: String
    let languageCodes: [String]?
    let installed: Bool
    var folder: URL = URL(fileURLWithPath: "/")

    private enum CodingKeys: String, CodingKey { case id, name, task, engine, languageCodes, installed }

    /// Only installed models count; a model mid-download or paused has an incomplete folder.
    static func installed(_ id: String, in modelsDir: URL?) throws -> DownloadedModel {
        guard let modelsDir, !id.isEmpty, !id.contains("/"), id != "..", id != "." else {
            throw ModelError.unavailable("Unknown speech-to-text model \(id)")
        }
        let folder = modelsDir.appending(path: id, directoryHint: .isDirectory)
        guard let data = try? Data(contentsOf: folder.appending(path: "manifest.json")),
              var model = try? JSONDecoder().decode(DownloadedModel.self, from: data)
        else { throw ModelError.unavailable("The model \(id) isn't downloaded. Download it in Settings → Models") }
        guard model.installed else {
            throw ModelError.unavailable("\(model.name) hasn't finished downloading. Finish it in Settings → Models")
        }
        model.folder = folder
        return model
    }
}
