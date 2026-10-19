const message = [
	'The Feishu connector reads your content through lark-cli; it stores no credentials itself.',
	'',
	'1. Install lark-cli (https://github.com/larksuite/cli) so that `lark-cli` is on the PATH Gety starts with.',
	'2. Sign in and grant the scopes the connector needs:',
	'   lark-cli auth login --recommend --scope "search:docs:read contact:user.basic_profile:readonly"',
	'',
	"Then run `deno task build` and install this folder from Gety's Custom Connectors settings page.",
	'See README.md for PATH requirements (nvm, fnm, volta and similar installs).',
].join('\n');

console.log(message);
