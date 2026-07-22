# Security model

> English first, Tiếng Việt below.

Local Coding Agent is a **trusted local execution engine**. It lets an authorized MCP client read and write files, run commands, manage processes, use Git, and call enabled desktop integrations with the permissions of the local user running LCA.

## English

### Trust boundary

- LCA is not an OS sandbox and has no read-only, approval, or policy mode.
- Tool actions execute directly. Project roots are discovery and relative-path defaults, not authorization boundaries.
- Absolute paths are accepted. Commands and Git operations can mutate data anywhere the local user can access.
- Connect only trusted users, projects, MCP clients, and desktop integrations. Use a VM, container, WSL2 instance, or dedicated OS account when stronger isolation is required.
- Prompt injection remains a real risk when the model reads untrusted repositories or data.

### Operational protections that remain enabled

- The HTTP server binds to loopback by default.
- The supported ChatGPT exposure path is the private OpenAI MCP tunnel. Do not publish the local endpoint through a public tunnel.
- Optional `MCP_AUTH_TOKEN` bearer authentication is accepted only through the `Authorization` header, never query strings.
- Browser-origin requests are denied unless their origin is explicitly listed in `MCP_ALLOWED_ORIGINS`.
- Request bodies, file reads, command output, process output, desktop calls, and context packs have bounded sizes and timeouts.
- Managed process trees are terminated during stop and graceful server exit.
- Audit events redact file content, patch bodies, commands, tokens, and other sensitive arguments before writing `server/data/audit.log`.
- Figma, DBeaver, Bruno, AgentMemory, and CodeGraph default to local or managed endpoints. Remote desktop MCP endpoints require an explicit allow-remote override.
- DBeaver SQL execution remains editor-first. Only the SQL Artifact Run action receives the hidden short-lived capability needed to open the native confirmation and execute the exact proposed SQL.

### Deployment rules

1. Keep the listener on `127.0.0.1`.
2. Keep tunnel credentials and desktop bearer tokens in `.env.local` or process environment only.
3. Never commit `.env*`, generated profiles, `tools/`, runtime data, backups, or logs.
4. Review `server/data/audit.log` when investigating unexpected actions.
5. Back up AgentMemory with `lca memory export`; backup files are written atomically with mode `0600` and a checksum.

## Tiếng Việt

Local Coding Agent là **execution engine cục bộ được tin tưởng**. MCP client đã kết nối có thể đọc/ghi file, chạy lệnh, quản lý process, dùng Git và gọi các desktop integration với đúng quyền của user đang chạy LCA.

- LCA không phải OS sandbox và không có mode read-only, policy hay approval.
- Tool chạy trực tiếp. Project roots chỉ dùng để discovery và làm mốc cho relative path, không phải ranh giới phân quyền.
- Absolute path được chấp nhận. Command và Git có thể thay đổi mọi dữ liệu mà user hiện tại có quyền truy cập.
- Chỉ kết nối user, project, MCP client và desktop app đáng tin. Cần cô lập mạnh hơn thì chạy trong VM, container, WSL2 hoặc một OS account riêng.
- Prompt injection từ repo hoặc dữ liệu không tin cậy vẫn là rủi ro thật.

Các lớp bảo vệ vận hành vẫn được giữ: bind loopback, private OpenAI MCP tunnel, bearer auth tùy chọn, origin allowlist, giới hạn body/output, timeout, cleanup process tree, audit redaction và local-only desktop endpoints. DBeaver SQL vẫn bắt buộc đi qua SQL Artifact Run và native confirmation với capability ẩn.

## Reporting vulnerabilities

Open a private GitHub security advisory or contact the maintainer. Do not publish exploitable details in a public issue.
