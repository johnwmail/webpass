# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |
| < Latest| :x:                |

Always use the latest version for the most secure experience.

## Reporting a Vulnerability

**Please do not open public issues for security vulnerabilities.**

### How to Report

1. **Email**: Send details to the maintainers privately
2. **GitHub**: Use [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)
- Your contact information

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 1 week
- **Fix Timeline**: Depends on severity
  - Critical: 24-72 hours
  - High: 1-2 weeks
  - Medium: 2-4 weeks
  - Low: Next release cycle

### Process

1. Submit report privately
2. Receive acknowledgment
3. Maintainers assess and reproduce
4. Fix is developed and tested
5. Security advisory published (if appropriate)
6. Patch released
7. Public disclosure (coordinated)

## Security Best Practices

### For Users

- **Always use HTTPS** in production
- **Set strong JWT_SECRET**: Use `openssl rand -hex 32` (or use random key for single-instance with short sessions)
- **Enable 2FA**: Add TOTP for server access
- **Regular backups**: Use git sync feature
- **Update regularly**: Keep up with latest releases

### For Developers

- **Never commit secrets**: Use environment variables
- **Review dependencies**: Keep Go modules updated
- **Run security scans**: `go audit`, `npm audit`
- **Test thoroughly**: Run `go test -race ./...`
- **Follow guidelines**: See [CONTRIBUTING.md](CONTRIBUTING.md)

## Security Features

WebPass implements several security measures:

### Zero-Knowledge Architecture

- Private keys never leave the browser
- Server stores only PGP-encrypted blobs
- Password validation happens client-side
- Server cannot decrypt user data

### Cryptography

- **PGP Encryption**: OpenPGP.js in browser
- **Password Hashing**: bcrypt on server
- **Session Tokens**: JWT with 5-minute expiry
- **2FA**: TOTP (RFC 6238)

### Network Security

- CORS enforcement
- HTTPS required in production
- No sensitive data in logs
- Rate limiting recommended

### Data Protection

- SQLite with file permissions
- Encrypted git sync (PGP-encrypted PAT)
- Secure session management
- Input validation on all endpoints
- Passphrase confirmation required for account deletion

### Account Deletion Security

WebPass provides two levels of account deletion:

1. **Clear Local Data** — Removes IndexedDB storage from the browser only. Requires PGP passphrase confirmation. Server account and data remain intact.

2. **Permanently Delete Account** — Complete deletion including:
   - All database entries
   - User account record
   - Git repository folder (`/data/git-repos/{fingerprint}/`)
   - Local IndexedDB data
   
   Requires PGP passphrase confirmation. This action cannot be undone.

**Security measures:**
- Passphrase verification before deletion
- JWT authentication required for server-side deletion
- Atomic deletion: database entries removed before user account
- Git repo deletion is scoped to user's fingerprint folder only

## Known Limitations

- Server admin can delete user data (but not read it)
- Client-side crypto relies on browser security
- Session tokens stored in browser storage

## Security Updates

Security updates are released as patch versions. Subscribe to releases for notifications.

## Recognition

Security researchers who report valid vulnerabilities will be acknowledged (unless they prefer to remain anonymous).

---

**Remember:** Security is a shared responsibility. Report issues responsibly and keep the community safe.
