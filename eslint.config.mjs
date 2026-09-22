import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

export default [...(await generateEslintConfig({ enableTypescript: true })), { ignores: ['.venv/**'] }]
