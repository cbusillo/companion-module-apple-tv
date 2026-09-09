"""Private stdio worker. Accepts credentials only over stdin; never echoes them."""
import asyncio
import json
import logging
import sys
from controller import PyATVController, HelperError

MAX_FRAME = 16384
async def serve(reader, emit, controller):
    controller.on_lost = lambda: emit({"id": 0, "state": "offline"})
    try:
        while True:
            try:
                line = await reader.readline()
            except ValueError:
                emit({"id": 0, "state": "offline", "error": "invalid_frame"})
                return
            if not line:
                return
            if len(line) > MAX_FRAME:
                return
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError("not_object")
            except (ValueError, UnicodeError):
                emit({"id": 0, "state": "offline", "error": "invalid_frame"})
                return
            request_id = request.get('id')
            operation = request.get('operation')
            if type(request_id) is not int or operation not in {'connect','status','action','disconnect'}:
                emit({'id':request_id,'error':'invalid_request'})
                continue
            try:
                outcome = await asyncio.wait_for(controller.handle(request), 12)
                emit({'id':request_id,'state':outcome['state'],'capabilities':outcome.get('capabilities',[])})
            except HelperError as error:
                emit({'id':request_id,'error':error.code,'state':error.state,'capabilities':[]})
            except Exception:
                # An action may already have reached the device. Never replay it.
                emit({'id':request_id,'error':'transport_failed','state':'offline','capabilities':[]})
                return
    finally:
        await controller.close()

async def main():
    reader=asyncio.StreamReader(limit=MAX_FRAME)
    await asyncio.get_running_loop().connect_read_pipe(lambda:asyncio.StreamReaderProtocol(reader),sys.stdin)
    def emit(value):print(json.dumps(value),flush=True)
    await serve(reader,emit,PyATVController())
if __name__=='__main__':
    logging.disable(logging.CRITICAL)
    try:asyncio.run(main())
    except Exception:sys.exit(1)
