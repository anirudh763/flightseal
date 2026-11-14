# AVFoundation video helper

`VideoAssetInspector.swift` is a source-only helper for a future Apple app target. It uses AVFoundation to
inspect a local `AVURLAsset` asynchronously and returns duration, codec FourCC, dimensions, and compatible
export presets. It accepts only file URLs whose source is a readable regular file; export also requires a local
`.mp4` destination. Its export method requires a compatible caller-selected preset and exports to a fresh MP4
URL; it preserves the source and refuses to replace a destination that already exists. These checks prevent
AVFoundation from receiving a remote URL.

This repository currently has no Xcode/iOS app project. The file can be typechecked against the installed
macOS SDK, but that does not verify an iOS build or runtime behavior. Add it to an actual app target before use.
