import AVFoundation
import CoreMedia
import Foundation

/// Metadata for a local asset. This helper never uploads or modifies the source asset.
public struct VideoAssetMetadata: Sendable {
    public struct VideoTrack: Sendable {
        public let codec: String
        public let width: Int32
        public let height: Int32
    }

    public let durationSeconds: Double
    public let videoTracks: [VideoTrack]
    public let compatibleExportPresets: [String]
}

public enum VideoAssetInspectorError: Error {
    case nonFileURL(URL)
    case sourceNotReadableRegularFile(URL)
    case invalidMP4Destination(URL)
    case noVideoTrack
    case outputAlreadyExists(URL)
    case exportSessionUnavailable
    case exportFailed(String)
}

public enum VideoAssetInspector {
    /// Asynchronously reads duration, codecs, dimensions, and presets supported for this asset.
    public static func inspect(_ url: URL) async throws -> VideoAssetMetadata {
        let asset = AVURLAsset(url: try validatedSourceURL(url))
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let duration = try await asset.load(.duration).seconds
        var videoTracks: [VideoAssetMetadata.VideoTrack] = []

        for track in tracks {
            let descriptions = try await track.load(.formatDescriptions)
            guard let description = descriptions.first else { continue }
            let dimensions = CMVideoFormatDescriptionGetDimensions(description)
            let subtype = CMFormatDescriptionGetMediaSubType(description)
            videoTracks.append(.init(
                codec: fourCharacterCode(subtype),
                width: dimensions.width,
                height: dimensions.height
            ))
        }

        guard !videoTracks.isEmpty else { throw VideoAssetInspectorError.noVideoTrack }
        return VideoAssetMetadata(
            durationSeconds: duration.isFinite ? duration : 0,
            videoTracks: videoTracks,
            compatibleExportPresets: await compatibleMP4Presets(for: asset)
        )
    }

    /// Exports to a fresh MP4 URL using a preset already reported as compatible for the asset.
    /// The source remains untouched and a pre-existing destination is preserved.
    public static func exportMP4(_ sourceURL: URL, to destinationURL: URL, preset: String) async throws {
        let sourceURL = try validatedSourceURL(sourceURL)
        guard destinationURL.isFileURL, destinationURL.pathExtension.lowercased() == "mp4" else {
            throw VideoAssetInspectorError.invalidMP4Destination(destinationURL)
        }
        guard !FileManager.default.fileExists(atPath: destinationURL.path) else {
            throw VideoAssetInspectorError.outputAlreadyExists(destinationURL)
        }

        let asset = AVURLAsset(url: sourceURL)
        let compatible = await compatibleMP4Presets(for: asset)
        guard compatible.contains(preset) else {
            throw VideoAssetInspectorError.exportFailed("The selected export preset is not compatible with this asset")
        }
        guard let session = AVAssetExportSession(asset: asset, presetName: preset) else {
            throw VideoAssetInspectorError.exportSessionUnavailable
        }

        let temporaryURL = destinationURL.deletingLastPathComponent()
            .appendingPathComponent(".flightseal-\(UUID().uuidString).mp4")
        defer { try? FileManager.default.removeItem(at: temporaryURL) }

        do {
            try await session.export(to: temporaryURL, as: .mp4)
        } catch {
            throw VideoAssetInspectorError.exportFailed(error.localizedDescription)
        }
        do {
            try FileManager.default.moveItem(at: temporaryURL, to: destinationURL)
        } catch {
            throw VideoAssetInspectorError.exportFailed("Could not publish export: \(error.localizedDescription)")
        }
    }

    private static func fourCharacterCode(_ value: FourCharCode) -> String {
        let bytes = [
            UInt8((value >> 24) & 0xff), UInt8((value >> 16) & 0xff),
            UInt8((value >> 8) & 0xff), UInt8(value & 0xff)
        ]
        let printable = bytes.map { byte -> Character in
            let scalar = UnicodeScalar(byte)
            guard scalar.isASCII, !CharacterSet.controlCharacters.contains(scalar) else {
                return "?"
            }
            return Character(scalar)
        }
        return String(printable)
    }

    private static func compatibleMP4Presets(for asset: AVAsset) async -> [String] {
        var compatible: [String] = []
        for preset in AVAssetExportSession.allExportPresets() {
            let result = await withCheckedContinuation { continuation in
                AVAssetExportSession.determineCompatibility(
                    ofExportPreset: preset,
                    with: asset,
                    outputFileType: .mp4
                ) { continuation.resume(returning: $0) }
            }
            if result { compatible.append(preset) }
        }
        return compatible
    }

    private static func validatedSourceURL(_ url: URL) throws -> URL {
        guard url.isFileURL else { throw VideoAssetInspectorError.nonFileURL(url) }
        guard
            let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
            attributes[.type] as? FileAttributeType == .typeRegular,
            FileManager.default.isReadableFile(atPath: url.path)
        else {
            throw VideoAssetInspectorError.sourceNotReadableRegularFile(url)
        }
        return url
    }
}
