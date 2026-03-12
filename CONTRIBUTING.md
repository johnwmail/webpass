# Contributing to WebPass

Thank you for considering contributing to WebPass! This document provides guidelines and instructions for contributing.

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Welcome newcomers and help them learn

## How to Contribute

### Reporting Bugs

Before creating bug reports, please check existing issues. When creating a bug report, include:

- Clear title and description
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, browser, versions)
- Screenshots or logs if applicable

**Example:**
```markdown
**Bug Summary**
Short description of the issue

**Steps to Reproduce**
1. Go to '...'
2. Click on '...'
3. See error

**Expected:** What should happen
**Actual:** What actually happened

**Environment:**
- OS: Windows 11
- Browser: Chrome 120
```

### Suggesting Features

Feature suggestions are welcome! Please provide:

- Use case and motivation
- Proposed solution
- Alternatives considered
- Potential impact

### Pull Requests

1. Fork the repository
2. Create a branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. Make your changes
4. Run tests and linters
5. Commit with clear messages
6. Push and open a PR

**PR Guidelines:**
- Reference related issues
- Include tests for new functionality
- Update documentation if needed
- Keep changes focused and atomic
- Ensure CI passes

## Development Setup

### Backend

```bash
# Install Go 1.26+
go version

# Install dependencies
go mod download

# Run tests
go test ./...

# Run linter
golangci-lint run

# Build
go build -o webpass-server ./cmd/srv
```

### Frontend

```bash
cd frontend

# Install Node.js 20+
node --version

# Install dependencies
npm install

# Run dev server
npm run dev

# Run tests
npm test

# Build
npm run build
```

### Database

```bash
# Generate sqlc code
cd db && go generate ./...
```

## Coding Standards

### Go

- Follow [Effective Go](https://go.dev/doc/effective_go)
- Use `gofmt` or `goimports`
- Add tests for new packages
- Keep functions small and focused
- Use meaningful variable names

### TypeScript/JavaScript

- Use TypeScript for all new code
- Follow existing code style
- Add types for function signatures
- Use ESLint/Prettier

### General

- Write self-documenting code
- Add comments for complex logic only
- Keep PRs under 400 lines when possible
- Update tests with code changes

## Architecture Overview

WebPass uses a zero-knowledge architecture:

- **Frontend**: Preact + TypeScript, handles all cryptography
- **Backend**: Go HTTP API, stores only encrypted blobs
- **Database**: SQLite with sqlc for type-safe queries

See [README.md](README.md) and [AGENTS.md](AGENTS.md) for details.

## Security Considerations

**Critical:** Never commit:
- Passwords or secrets
- API keys or tokens
- Private encryption keys
- Production database files

Report security vulnerabilities privately to the maintainers.

## Questions?

Open an issue for questions or discussions.

---

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
