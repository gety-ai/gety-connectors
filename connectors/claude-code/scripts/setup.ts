const message = [
	'Claude Code setup:',
	'',
	'No setup is required. The connector auto-detects the Claude Code projects',
	'directory:',
	'  Linux/macOS: ~/.claude/projects',
	'  Windows:     %USERPROFILE%\\.claude\\projects',
	'',
	'Set INCLUDE_SUBAGENTS=true to include Claude Code subagent/workflow logs.',
	'',
	"Run `deno task build`, then install this folder from Gety's Custom Connectors settings page.",
].join('\n');

console.log(message);
