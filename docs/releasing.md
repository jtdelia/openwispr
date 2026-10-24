# Releasing OpenWispr for macOS

Pushing a version tag builds an Apple-silicon DMG, signs it with a Developer ID
certificate, notarizes it with Apple, and publishes it to a GitHub Release. The
DMG contains `OpenWispr.app` and an Applications alias for drag-and-drop
installation.

## Apple prerequisites

Public distribution requires a paid Apple Developer Program membership.

1. Create a **Developer ID Application** certificate in the Apple Developer
   portal, install it in Keychain Access, and export the certificate and private
   key as a password-protected `.p12` file.
2. In App Store Connect, create a Team API key with App Manager access. Download
   its `.p8` file and record its key ID and issuer ID.
3. Configure these GitHub Actions repository secrets:

   | Secret | Value |
   | --- | --- |
   | `MACOS_CERTIFICATE` | Base64-encoded `.p12` file |
   | `MACOS_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12` |
   | `APPLE_API_KEY_BASE64` | Base64-encoded App Store Connect `.p8` file |
   | `APPLE_API_KEY_ID` | App Store Connect API key ID |
   | `APPLE_API_ISSUER` | App Store Connect API issuer UUID |

   On macOS, encode either file with `base64 < path/to/file | pbcopy`, then
   paste the clipboard into the corresponding GitHub secret. Never commit the
   certificate, API key, or passwords.

## Publish a release

1. Update the version in both `package.json` and `package-lock.json`:

   ```bash
   npm version 0.2.0 --no-git-tag-version
   ```

2. Commit and merge the version change to `main`.
3. Tag that commit and push the tag:

   ```bash
   git switch main
   git pull --ff-only
   git tag v0.2.0
   git push origin v0.2.0
   ```

The tag must exactly equal `v` followed by the version in `package.json`, and
its commit must be on `main`. Tags containing a prerelease version, such as
`v0.2.0-beta.1`, produce a prerelease.

The release workflow verifies the notarization ticket, Gatekeeper acceptance,
code signature, and Applications alias before publishing the DMG and its
SHA-256 checksum. Re-running the workflow replaces the existing assets instead
of creating a duplicate release.
