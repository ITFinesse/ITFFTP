const esbuild = require('esbuild');
const path = require('path');

async function main() {
    const ctx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        minify: false,
        sourcemap: !process.argv.includes('--minify'),
        sourcesContent: false,
        platform: 'node',
        target: 'node16.14', // Match VS Code's Node version range
        outfile: 'dist/extension.js',
        // VS Code provides only the `vscode` module at runtime. Bundle every
        // other dependency so the VSIX cannot activate with a missing module.
        // cpu-features is an optional native acceleration module used behind
        // ssh2's guarded fallback; omitting it keeps the VSIX portable.
        external: ['vscode', 'cpu-features'],
        logLevel: 'info',
        mainFields: ['module', 'main'],
        nodePaths: process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [],
    });

    if (process.argv.includes('--watch')) {
        await ctx.watch();
    } else {
        await ctx.rebuild();
        await ctx.dispose();
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
