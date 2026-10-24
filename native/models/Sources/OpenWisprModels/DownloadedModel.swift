import Foundation

/// A model the app downloaded into `<models dir>/<id>/`, as described by its `manifest.json`.
struct DownloadedModel: Decodable, Sendable {
    let id: String
    let name: String
    let task: String
    let engine: String
    let languageCodes: [String]?
    /// Extra chat template variables, like `enable_thinking: false` for models that think by default.
    let chatTemplateContext: [String: Bool]?
    let installed: Bool
    var folder: URL = URL(fileURLWithPath: "/")

    private enum CodingKeys: String, CodingKey { case id, name, task, engine, languageCodes, chatTemplateContext, installed }

    /// Where the model `id` lives, whether or not it's downloaded.
    static func folder(_ id: String, in modelsDir: URL?) throws -> URL {
        guard let modelsDir, !id.isEmpty, !id.contains("/"), id != "..", id != "." else {
            throw ModelError.unavailable("Unknown model \(id)")
        }
        return modelsDir.appending(path: id, directoryHint: .isDirectory)
    }

    /// Only installed models count; a model mid-download or paused has an incomplete folder.
    static func installed(_ id: String, in modelsDir: URL?) throws -> DownloadedModel {
        let folder = try folder(id, in: modelsDir)
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
