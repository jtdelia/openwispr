import Foundation

enum PCM16 {
    static let sampleRate = 16_000

    /// Samples from a 16 kHz mono PCM16 WAV file, or from raw little-endian samples.
    static func samples(from data: Data) throws -> [Int16] {
        let bytes = [UInt8](data)
        let payload = isWAV(bytes) ? try wavPayload(bytes) : bytes[...]
        var samples = [Int16](repeating: 0, count: payload.count / 2)
        var index = payload.startIndex
        for i in samples.indices {
            samples[i] = Int16(bitPattern: UInt16(payload[index]) | UInt16(payload[index + 1]) << 8)
            index += 2
        }
        return samples
    }

    private static func isWAV(_ bytes: [UInt8]) -> Bool {
        bytes.count >= 12 && bytes[0..<4].elementsEqual("RIFF".utf8) && bytes[8..<12].elementsEqual("WAVE".utf8)
    }

    private static func wavPayload(_ bytes: [UInt8]) throws -> ArraySlice<UInt8> {
        func uint32(_ at: Int) -> Int {
            Int(bytes[at]) | Int(bytes[at + 1]) << 8 | Int(bytes[at + 2]) << 16 | Int(bytes[at + 3]) << 24
        }
        func uint16(_ at: Int) -> Int { Int(bytes[at]) | Int(bytes[at + 1]) << 8 }

        var offset = 12
        while offset + 8 <= bytes.count {
            let size = uint32(offset + 4)
            let body = offset + 8
            if bytes[offset..<offset + 4].elementsEqual("fmt ".utf8), body + 16 <= bytes.count {
                let (format, channels, rate, bits) = (uint16(body), uint16(body + 2), uint32(body + 4), uint16(body + 14))
                guard format == 1, channels == 1, rate == sampleRate, bits == 16 else {
                    throw ModelError.modelFailed("Audio must be 16 kHz mono 16-bit PCM (got \(rate) Hz, \(channels) channels, \(bits)-bit)")
                }
            }
            if bytes[offset..<offset + 4].elementsEqual("data".utf8) {
                return bytes[body..<min(body + size, bytes.count)]
            }
            offset = body + size + (size & 1)
        }
        throw ModelError.modelFailed("The WAV audio has no data chunk")
    }
}
