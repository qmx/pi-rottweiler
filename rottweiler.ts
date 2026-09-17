/**
 * rottweiler — command guard extension.
 *
 * Blocks destructive or dangerous shell commands in pi before they run:
 * destructive git operations, the ssh family, and whole-filesystem `find /`.
 *
 * Rather than regex-matching raw text (which both over-blocks words inside
 * commit messages/strings and under-blocks wrapped invocations), it tokenizes
 * the shell command and inspects the actual command words (argv[0]) — after
 * shell separators and common wrapper commands (sudo, timeout, xargs, env,
 * nohup, ...). Quoted text is treated as data, not commands, so words like
 * "ssh" in a commit message or echoed string don't trigger a block.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

interface Token {
	text: string;
	quoted: boolean;
	sep: boolean;
}

const SSH_FAMILY = new Set(["ssh", "ssh-add", "ssh-agent", "ssh-copy-id", "sshd", "sftp", "scp", "slogin"]);

/** Wrappers that run a command as a later argument (the actual argv[0]). */
const WRAPPERS = new Set([
	"sudo", "doas", "runuser", "env", "time", "timeout", "nohup", "nice", "ionice",
	"command", "setsid", "taskset", "xargs", "watch", "stdbuf", "script", "chroot",
]);

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "ash"]);

/** Wrapper options that consume a following value (so we don't mistake the
 * value for the command). Keyed per wrapper to resolve clashes like `-i`
 * (sudo = login flag, stdbuf = input-buffer size). */
const WRAPPER_OPT_VALUE: Record<string, Set<string>> = {
	sudo: new Set(["-u", "--user", "-g", "--group", "-p", "--prompt", "-h", "--host", "-C", "--close-from", "-D", "--chdir", "-R", "--chroot", "-T", "--command-timeout"]),
	doas: new Set(["-u", "-C"]),
	runuser: new Set(["-u", "-g", "-G"]),
	env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
	timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
	time: new Set(),
	nohup: new Set(),
	nice: new Set(["-n", "--adjustment"]),
	ionice: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid"]),
	taskset: new Set(["-c", "--cpu-list"]),
	command: new Set(),
	setsid: new Set(),
	xargs: new Set(["-a", "--arg-file", "-d", "--delimiter", "-I", "--replace", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars", "-L"]),
	watch: new Set(["-n", "--interval"]),
	stdbuf: new Set(["-i", "-o", "-e"]),
	script: new Set(["-c", "--command"]),
	chroot: new Set(["-u", "-g", "--userspec", "--groups"]),
};

/** Tokenize a shell command. Quoted strings become single (quoted) tokens;
 * shell separators and command substitutions become `sep` tokens. */
function tokenize(cmd: string): Token[] {
	const tokens: Token[] = [];
	let word = "";
	let inWord = false;
	const flush = () => {
		if (inWord) {
			tokens.push({ text: word, quoted: false, sep: false });
			word = "";
			inWord = false;
		}
	};
	let i = 0;
	while (i < cmd.length) {
		const c = cmd[i];
		if (c === "'") {
			flush();
			const end = cmd.indexOf("'", i + 1);
			const text = end === -1 ? cmd.slice(i + 1) : cmd.slice(i + 1, end);
			tokens.push({ text, quoted: true, sep: false });
			i = end === -1 ? cmd.length : end + 1;
		} else if (c === '"') {
			flush();
			let j = i + 1;
			let buf = "";
			while (j < cmd.length && cmd[j] !== '"') {
				if (cmd[j] === "\\" && (cmd[j + 1] === '"' || cmd[j + 1] === "\\" || cmd[j + 1] === "$" || cmd[j + 1] === "`")) {
					buf += cmd[j + 1];
					j += 2;
				} else {
					buf += cmd[j];
					j++;
				}
			}
			tokens.push({ text: buf, quoted: true, sep: false });
			i = j + 1;
		} else if (c === "\\") {
			if (i + 1 < cmd.length) {
				word += cmd[i + 1];
				inWord = true;
				i += 2;
			} else {
				word += "\\";
				inWord = true;
				i++;
			}
		} else if (c === " " || c === "\t") {
			flush();
			i++;
		} else if ("\n;|&(){}<>`".includes(c)) {
			flush();
			tokens.push({ text: c, quoted: false, sep: true });
			i++;
		} else if (c === "$" && cmd[i + 1] === "(") {
			flush();
			tokens.push({ text: "(", quoted: false, sep: true });
			i += 2;
		} else {
			word += c;
			inWord = true;
			i++;
		}
	}
	flush();
	return tokens;
}

function splitSegments(tokens: Token[]): Token[][] {
	const segs: Token[][] = [];
	let cur: Token[] = [];
	for (const t of tokens) {
		if (t.sep) {
			if (cur.length) {
				segs.push(cur);
				cur = [];
			}
		} else {
			cur.push(t);
		}
	}
	if (cur.length) segs.push(cur);
	return segs;
}

/** Index of the real command token after a wrapper, skipping its options,
 * option-values, env assignments, and (for duration-style wrappers) numbers. */
function nextCommandIndex(seg: Token[], start: number, wrapper: string): number {
	const valueOpts = WRAPPER_OPT_VALUE[wrapper] ?? new Set<string>();
	let i = start;
	while (i < seg.length) {
		const t = seg[i];
		if (t.quoted) return i;
		const txt = t.text;
		if (WRAPPERS.has(txt) || SHELLS.has(txt)) return i;
		if (txt.startsWith("-")) {
			i += valueOpts.has(txt) ? 2 : 1;
			continue;
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(txt)) {
			i++;
			continue;
		}
		if ((wrapper === "timeout" || wrapper === "nice" || wrapper === "ionice" || wrapper === "taskset") && /^\d/.test(txt)) {
			i++;
			continue;
		}
		return i;
	}
	return -1;
}

/** Index of the first real command token, skipping leading env assignments
 * like `GIT_TRACE=1 git push ...`. Bash treats leading `VAR=...` as an env
 * prefix and still runs the following command, so without this the real
 * command word would hide behind the assignment and evade the guard. */
function leadingCommandIndex(seg: Token[]): number {
	let i = 0;
	while (i < seg.length) {
		const t = seg[i];
		if (t.quoted) return i;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text)) {
			i++;
			continue;
		}
		return i;
	}
	return -1;
}

function gitSubcommandIndex(seg: Token[], idx: number): number {
	let j = idx + 1;
	while (j < seg.length) {
		const t = seg[j];
		if (t.text === "-C" || t.text === "-c") {
			j += 2;
			continue;
		}
		if (t.text.startsWith("--git-dir=") || t.text.startsWith("--work-tree=") || t.text === "--bare") {
			j += 1;
			continue;
		}
		if (t.text.startsWith("-")) {
			j += 1;
			continue;
		}
		return j;
	}
	return -1;
}

function checkCommand(seg: Token[], idx: number): string | null {
	const text = seg[idx].text;

	if (SSH_FAMILY.has(text)) return "ssh-family command is blocked";

	if (text === "find") {
		let j = idx + 1;
		while (j < seg.length && seg[j].text.startsWith("-")) j++;
		if (j < seg.length && seg[j].text === "/") return "find on the whole filesystem is blocked";
		return null;
	}

	if (text === "git") {
		const subIdx = gitSubcommandIndex(seg, idx);
		if (subIdx === -1) return null;
		const sub = seg[subIdx].text;
		if (sub === "push" || sub === "update-ref") {
			return sub === "push" ? "git push is blocked" : "git update-ref is blocked";
		}
		if (sub === "tag") {
			const next = seg[subIdx + 1];
			if (next && (next.text === "-d" || next.text === "--delete")) return "Deleting tags is blocked";
		}
		if (sub === "reset") {
			const next = seg[subIdx + 1];
			if (next && next.text === "--hard") return "git reset --hard is blocked";
		}
	}

	return null;
}

function checkSegment(seg: Token[], depth: number): string | null {
	if (depth > 6 || seg.length === 0) return null;

	const candidates = new Map<number, Token>();
	const firstIdx = leadingCommandIndex(seg);
	if (firstIdx !== -1 && !seg[firstIdx].quoted) candidates.set(firstIdx, seg[firstIdx]);
	for (let i = 0; i < seg.length; i++) {
		const t = seg[i];
		if (t.quoted) continue;
		if (WRAPPERS.has(t.text)) {
			const ni = nextCommandIndex(seg, i + 1, t.text);
			if (ni !== -1) candidates.set(ni, seg[ni]);
		}
	}

	for (const [idx, tok] of candidates) {
		const reason = checkCommand(seg, idx);
		if (reason) return reason;

		// shell -c '<command>': recurse into the quoted command string
		if (SHELLS.has(tok.text)) {
			const next = seg[idx + 1];
			if (next && next.text === "-c" && seg[idx + 2]) {
				const inner = checkSegment(tokenize(seg[idx + 2].text).filter((t) => !t.sep), depth + 1);
				if (inner) return inner;
			}
		}
	}

	// first token as a shell with -c (e.g. `bash -c 'ssh host'`)
	if (SHELLS.has(seg[0].text) && seg[1] && seg[1].text === "-c" && seg[2]) {
		const inner = checkSegment(tokenize(seg[2].text).filter((t) => !t.sep), depth + 1);
		if (inner) return inner;
	}

	return null;
}

export function isBlockedCommand(command: string): string | null {
	if (!command || command.trim() === "") return null;
	const tokens = tokenize(command);
	for (const seg of splitSegments(tokens)) {
		const reason = checkSegment(seg, 0);
		if (reason) return reason;
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command;
		const reason = isBlockedCommand(command);

		if (reason) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Blocked: ${reason}`, "warning");
			}

			return { block: true, reason };
		}
	});
}
