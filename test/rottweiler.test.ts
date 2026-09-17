import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedCommand } from "../rottweiler.ts";

/** Assert the command is blocked (optionally for a specific reason). */
function block(cmd: string, reason?: string) {
	const r = isBlockedCommand(cmd);
	assert.ok(r !== null, `expected ${JSON.stringify(cmd)} to be blocked, got null`);
	if (reason !== undefined) {
		assert.equal(r, reason, `unexpected reason for ${JSON.stringify(cmd)}`);
	}
}

/** Assert the command is allowed through. */
function allow(cmd: string) {
	const r = isBlockedCommand(cmd);
	assert.equal(r, null, `expected ${JSON.stringify(cmd)} to be allowed, got ${JSON.stringify(r)}`);
}

// ---------------------------------------------------------------------------
// git push
// ---------------------------------------------------------------------------

test("blocks git push", () => {
	block("git push origin main", "git push is blocked");
	block("git push -u origin main", "git push is blocked");
	block("git push -f origin main", "git push is blocked");
	block("git push --force origin main", "git push is blocked");
	block("git push origin sops-ssh-key-user", "git push is blocked");
	block("git -C /path/to/repo push origin main", "git push is blocked");
});

test("blocks git push hidden behind a leading env prefix", () => {
	// Regression: GIT_TRACE=1 was previously the first token, hiding the real git push.
	block("GIT_TRACE=1 git push origin main", "git push is blocked");
	block("GIT_TRACE=1 git push -u origin sops-ssh-key-user", "git push is blocked");
	block("FOO=1 BAR=2 git push origin main", "git push is blocked");
});

test("blocks git push behind a wrapper with an env prefix", () => {
	block("sudo git push origin main", "git push is blocked");
	block("sudo GIT_TRACE=1 git push origin main", "git push is blocked");
	block("timeout 10 git push origin main", "git push is blocked");
});

test("blocks git push nested in a shell -c", () => {
	block("bash -c 'git push origin main'", "git push is blocked");
	block("bash -c 'GIT_TRACE=1 git push origin main'", "git push is blocked");
	block("sh -c 'sudo git push origin main'", "git push is blocked");
});

// ---------------------------------------------------------------------------
// other destructive git operations
// ---------------------------------------------------------------------------

test("blocks git update-ref", () => {
	block("git update-ref refs/heads/main HEAD", "git update-ref is blocked");
});

test("blocks git tag deletion", () => {
	block("git tag -d v1.0", "Deleting tags is blocked");
	block("git tag --delete v1.0", "Deleting tags is blocked");
});

test("blocks git reset --hard", () => {
	block("git reset --hard HEAD", "git reset --hard is blocked");
	block("git reset --hard origin/main", "git reset --hard is blocked");
});

// ---------------------------------------------------------------------------
// ssh family
// ---------------------------------------------------------------------------

test("blocks the ssh family", () => {
	block("ssh host", "ssh-family command is blocked");
	block("ssh -p 2222 user@host", "ssh-family command is blocked");
	block("scp file.txt user@host:/tmp", "ssh-family command is blocked");
	block("sftp user@host", "ssh-family command is blocked");
	block("ssh-add ~/.ssh/id_ed25519", "ssh-family command is blocked");
	block("sudo ssh host", "ssh-family command is blocked");
});

// ---------------------------------------------------------------------------
// whole-filesystem find
// ---------------------------------------------------------------------------

test("blocks find on the whole filesystem", () => {
	block("find /", "find on the whole filesystem is blocked");
	block("sudo find / -name foo", "find on the whole filesystem is blocked");
});

// ---------------------------------------------------------------------------
// should be allowed
// ---------------------------------------------------------------------------

test("allows safe commands", () => {
	allow("git status");
	allow("git commit -m wip");
	allow("git log --oneline");
	allow("git tag v1.0");
	allow("git reset --soft HEAD");
	allow("ls -la");
	allow("find . -name '*.ts'");
	allow("find /tmp -type f");
	allow("cat file.txt");
});

test("allows blocked words inside quoted strings / messages", () => {
	allow("echo 'git push is fine'");
	allow("git commit -m 'add ssh key'");
	allow("echo ssh host");
	allow("echo \"find /\"");
});

test("allows env prefix in front of safe commands", () => {
	allow("GIT_TRACE=1 git status");
	allow("FOO=1 ls");
});

test("allows heredoc bodies (they are data, not commands)", () => {
	// Regression: heredoc content used to be tokenized as command words,
	// so a commit message mentioning the blocked phrase was over-blocked.
	allow("git commit -F- <<'EOF'\n  git push origin main\nEOF");
	allow("cat <<'EOF'\nssh host\nEOF");
	allow("cat <<-EOF\n\tgit push origin main\n\tEOF");
});

test("heredocs do not mask a real dangerous command", () => {
	block("git push origin main <<'EOF'\ndata\nEOF", "git push is blocked");
	block("ssh host <<EOF\ndata\nEOF", "ssh-family command is blocked");
});
