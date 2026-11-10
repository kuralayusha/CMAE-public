# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Report them
privately through GitHub's "Report a vulnerability" feature (Security tab →
Advisories) on this repository, with steps to reproduce and the affected
version. We will acknowledge the report and work on a fix as soon as we can.

## Notes

- Never commit `.env` files, API keys, or the `master.key` file.
- CMAE stores the OpenRouter key and Gmail App Password encrypted (AES-256-GCM)
  in a local SQLite database; protect the app data folder accordingly.
