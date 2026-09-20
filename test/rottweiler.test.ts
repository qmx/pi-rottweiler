import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedCommand, isGitPushCommand } from "../rottweiler.ts";

type BlockOpts = { currentBranch?: string };

/** Assert the command is blocked (optionally for a specific reason). */
function block(cmd: string, reason?: string, opts?: BlockOpts) {
	const r = isBlockedCommand(cmd, opts);
	assert.ok(r !== null, `expected ${JSON.stringify(cmd)} to be blocked, got null`);
	if (reason !== undefined) {
		assert.equal(r, reason, `unexpected reason for ${JSON.stringify(cmd)}`);
	}
}

/** Assert the command is allowed through. */
function allow(cmd: string, opts?: BlockOpts) {
	const r = isBlockedCommand(cmd, opts);
	assert.equal(r, null, `expected ${JSON.stringify(cmd)} to be allowed, got ${JSON.stringify(r)}`);
}

// ---------------------------------------------------------------------------
// git push — only pushes to master/main are blocked
// ---------------------------------------------------------------------------

test("blocks push to main", () => {
	block("git push origin main", "git push to main is blocked");
	block("git push -u origin main", "git push to main is blocked");
	block("git push -f origin main", "git push to main is blocked");
	block("git push --force origin main", "git push to main is blocked");
	block("git -C /path/to/repo push origin main", "git push to main is blocked");
});

test("blocks push to master", () => {
	block("git push origin master", "git push to master is blocked");
	block("git push -u origin master", "git push to master is blocked");
	block("git push origin master:master", "git push to master is blocked");
});

test("blocks push whose remote-side target is a protected branch", () => {
	block("git push origin my-branch:main", "git push to main is blocked");
	block("git push origin feature:master", "git push to master is blocked");
	block("git push origin :main", "git push to main is blocked"); // delete remote main
	block("git push origin main:refs/heads/main", "git push to main is blocked");
});

test("allows pushes to other branches", () => {
	allow("git push origin my-branch");
	allow("git push -u origin my-branch");
	allow("git push origin feature/x");
	allow("git push origin my-branch:other");
});

test("bare git push depends on the current branch", () => {
	block("git push", "git push to master is blocked", { currentBranch: "master" });
	block("git push", "git push to main is blocked", { currentBranch: "main" });
	allow("git push", { currentBranch: "feature" });
	// unknown branch → cannot decide → allow
	allow("git push");
});

test("git push with only a remote depends on the current branch", () => {
	block("git push origin", "git push to main is blocked", { currentBranch: "main" });
	allow("git push origin", { currentBranch: "my-branch" });
});

test("blocks protected push hidden behind a leading env prefix", () => {
	// Regression: GIT_TRACE=1 was previously the first token, hiding the real git push.
	block("GIT_TRACE=1 git push origin main", "git push to main is blocked");
	block("FOO=1 BAR=2 git push origin master", "git push to master is blocked");
	allow("GIT_TRACE=1 git push origin my-branch");
});

test("blocks protected push behind a wrapper with an env prefix", () => {
	block("sudo git push origin main", "git push to main is blocked");
	block("sudo GIT_TRACE=1 git push origin master", "git push to master is blocked");
	block("timeout 10 git push origin main", "git push to main is blocked");
});

test("blocks protected push nested in a shell -c", () => {
	block("bash -c 'git push origin main'", "git push to main is blocked");
	block("bash -c 'GIT_TRACE=1 git push origin master'", "git push to master is blocked");
	block("sh -c 'sudo git push origin main'", "git push to main is blocked");
});

test("isGitPushCommand detects push commands the handler must resolve", () => {
	assert.equal(isGitPushCommand("git push origin main"), true);
	assert.equal(isGitPushCommand("git push"), true);
	assert.equal(isGitPushCommand("GIT_TRACE=1 git push"), true);
	assert.equal(isGitPushCommand("sudo git push origin main"), true);
	assert.equal(isGitPushCommand("git status"), false);
	assert.equal(isGitPushCommand("git commit -m wip"), false);
	assert.equal(isGitPushCommand(""), false);
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
	block("git push origin main <<'EOF'\ndata\nEOF", "git push to main is blocked");
	block("ssh host <<EOF\ndata\nEOF", "ssh-family command is blocked");
});
