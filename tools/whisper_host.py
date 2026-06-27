#!/usr/bin/env python3
"""
Chrome Native Messaging host — wraps whisper for the Video Media Grabber extension.
Protocol: each message is a 4-byte LE uint32 length prefix followed by UTF-8 JSON.
Input:  {"b64": "<base64 audio>", "model": "large-v3", "lang": "Chinese"}
Output: {"ok": true, "text": "...", "chunks": [{"timestamp": [start, end], "text": "..."}]}
        {"ok": false, "error": "..."}
"""
import sys, os, json, struct, base64, tempfile
os.environ['PATH'] = '/opt/homebrew/bin:/usr/local/bin:' + os.environ.get('PATH', '')

# Optional numpy compat shim (needed when system numba wants NumPy < 2.3)
_NP_SHIM = '/tmp/codex-whisper-numpy-2.2'
if os.path.exists(_NP_SHIM):
    sys.path.insert(0, _NP_SHIM)


def _read():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    return json.loads(sys.stdin.buffer.read(struct.unpack('<I', raw)[0]).decode())


def _write(obj):
    data = json.dumps(obj, ensure_ascii=False).encode()
    sys.stdout.buffer.write(struct.pack('<I', len(data)) + data)
    sys.stdout.buffer.flush()


def _choose_device():
    import torch
    if torch.cuda.is_available():
        return 'cuda'
    if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():
        return 'mps'
    return 'cpu'


_cache = {}


def _get_model(name):
    if name not in _cache:
        import whisper
        dev = _choose_device()
        m = whisper.load_model(name, device='cpu' if dev == 'mps' else dev)
        if dev == 'mps':
            ah = getattr(m, 'alignment_heads', None)
            if ah is not None and getattr(ah, 'is_sparse', False):
                m.alignment_heads = ah.to_dense()
            m = m.to('mps')
        _cache[name] = (m, dev)
    return _cache[name]


def _transcribe(msg):
    import whisper
    audio = base64.b64decode(msg['b64'])
    with tempfile.NamedTemporaryFile(suffix='.webm', delete=False) as f:
        f.write(audio)
        path = f.name
    try:
        model, dev = _get_model(msg.get('model', 'large-v3'))
        lang = msg.get('lang', 'Chinese')
        if lang in ('mixed', 'auto', None):
            lang = None
        result = whisper.transcribe(
            model, path,
            language=lang,
            task='transcribe',
            fp16=dev in ('cuda', 'mps'),
            verbose=False,
            temperature=0,
        )
        return {
            'ok': True,
            'text': result['text'],
            'chunks': [
                {'timestamp': [s['start'], s['end']], 'text': s['text']}
                for s in result.get('segments', [])
            ],
            'durationMs': round(result.get('duration', 0) * 1000),
        }
    finally:
        os.unlink(path)


while True:
    msg = _read()
    if msg is None:
        break
    try:
        _write(_transcribe(msg))
    except Exception as e:
        _write({'ok': False, 'error': str(e)})
