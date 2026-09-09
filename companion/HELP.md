# Apple TV (pyatv prototype)

Disabled by default. Requires a separately prepared local Python environment and owner-only credential JSON file. Read README.md before enabling a physical pilot.

This module communicates directly with pyatv in its own child process, without the MCR app. It does not pair devices or claim physical outcome confirmation. Supported commands depend on the connected device's reported capabilities.

Retain MCR for rollback until the replacement passes physical qualification. Do not paste credentials into configuration fields or committed files.
