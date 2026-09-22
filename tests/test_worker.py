import asyncio
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'bridge'))
from worker import serve
from controller import HelperError,PyATVController
class Fake:
 def __init__(self, fail=None):self.calls=[];self.closed=False;self.fail=fail
 async def handle(self,request):
  self.calls.append(request)
  if self.fail:raise self.fail
  return {'state':'ready','capabilities':['navigation'],'secret':{'credentials':'DO-NOT-EMIT'},'targets':[{'host':'private'}]}
 async def close(self):self.closed=True
class WorkerTests(unittest.IsolatedAsyncioTestCase):
 async def run_worker(self,requests,c):
  reader=asyncio.StreamReader();reader.feed_data(b''.join(json.dumps(r).encode()+b'\n' for r in requests));reader.feed_eof();out=[];await serve(reader,out.append,c);return out
 async def test_no_secret_echo(self):
  c=Fake();out=await self.run_worker([{'id':1,'operation':'connect','secret':{'credentials':'DO-NOT-EMIT'}}],c);self.assertNotIn('DO-NOT-EMIT',json.dumps(out));self.assertNotIn('private',json.dumps(out));self.assertTrue(c.closed)
 async def test_no_pairing_or_arbitrary_operations(self):
  c=Fake();out=await self.run_worker([{'id':1,'operation':'beginPairing'}],c);self.assertEqual(out[0]['error'],'invalid_request');self.assertEqual(c.calls,[])
 async def test_transport_error_stops_remaining_actions(self):
  c=Fake(RuntimeError('private credential error'));out=await self.run_worker([{'id':1,'operation':'action'},{'id':2,'operation':'action'}],c);self.assertEqual(len(c.calls),1);self.assertEqual(out[0]['error'],'transport_failed');self.assertNotIn('private',json.dumps(out));self.assertTrue(c.closed)
 async def test_unsupported_is_categorized(self):
  out=await self.run_worker([{'id':1,'operation':'action'}],Fake(HelperError('unsupportedAction','ready')));self.assertEqual(out[0]['error'],'unsupportedAction')
 async def test_controller_rejects_offline_action(self):
  with self.assertRaises(HelperError):await PyATVController().handle({'operation':'action','action':{'action':'home'}})
 async def test_malformed_json_closes_without_reply_or_stale_id(self):
  reader=asyncio.StreamReader();reader.feed_data(b'{"id":1,"operation":"status"}\nnot-json\n');reader.feed_eof()
  c=Fake();out=[]
  await serve(reader,out.append,c)
  self.assertEqual(len(out),2);self.assertEqual(out[0]['id'],1);self.assertEqual(out[1]['id'],0);self.assertTrue(c.closed)
 async def test_exact_frame_boundary_matches_transport(self):
  from worker import MAX_FRAME
  for length in (MAX_FRAME, MAX_FRAME+1):
   prefix=b'{"id":1,"operation":"status","padding":"';suffix=b'"}\n'
   frame=prefix+b'x'*(length-len(prefix)-len(suffix))+suffix
   reader=asyncio.StreamReader(limit=MAX_FRAME);reader.feed_data(frame);reader.feed_eof();c=Fake();out=[]
   await serve(reader,out.append,c)
   self.assertEqual(len(c.calls), 1 if length==MAX_FRAME else 0)
   self.assertTrue(c.closed)
if __name__=='__main__':unittest.main()
