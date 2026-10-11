# Local-first and single-user

OpenWispr has no accounts, cloud sync, teams, billing, sharing or mobile apps. Settings, history and meetings stay in `~/Library/Application Support/OpenWispr`, and the app only talks to the endpoints the user configures. Wispr Flow builds much of its product on its own backend (sync, team dictionaries, shared notes, HIPAA mode, referrals); we skip all of it so that OpenWispr works with any OpenAI-compatible or local server and never holds user data itself.

## Consequences

Wispr features that exist only because of its backend are out of scope, not just postponed. These include Private Cloud Sync, team dictionary and snippet sharing, shared notes and folders, HIPAA mode, referrals, and the iPhone and Android apps.
