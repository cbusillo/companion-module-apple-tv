import readline from 'node:readline'
for await (const line of readline.createInterface({ input: process.stdin })) {
	const request = JSON.parse(line)
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
