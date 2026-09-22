import readline from 'node:readline'
for await (const line of readline.createInterface({ input: process.stdin })) {
	const request = JSON.parse(line)
	if (request.operation === 'lost') {
		console.log(JSON.stringify({ id: 0, state: 'offline' }))
		continue
	}
	if (request.operation === 'unicode') {
		const bytes = Buffer.from(JSON.stringify({ id: request.id, state: 'ready', capabilities: ['é'] }) + '\n')
		const offset = bytes.indexOf(0xc3) + 1
		process.stdout.write(bytes.subarray(0, offset))
		await new Promise((r) => setTimeout(r, 20))
		process.stdout.write(bytes.subarray(offset))
		continue
	}
	if (request.operation === 'hang') continue
	if (request.operation === 'malformed') {
		console.log('invalid')
		continue
	}
	if (request.operation === 'oversize') {
		console.log('x'.repeat(70000))
		continue
	}
	if (request.operation === 'exit') {
		process.stdin.destroy()
		break
	}
	console.log(JSON.stringify({ id: request.id, state: 'ready', capabilities: ['navigation'] }))
}
