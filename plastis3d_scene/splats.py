"""Bounded Gaussian splat decoding. Canonical output is 32-byte .splat records."""
import math
import struct
import time
from .spec import PlastisError

MAX_SPLATS = 2_000_000

def fail(message):
    raise PlastisError('IMPORT_FORMAT', message)

def decode(data, source_format):
    deadline = time.monotonic() + 30
    def check_timeout(index):
        if index % 1024 == 0 and time.monotonic() > deadline:
            raise PlastisError("IMPORT_TIMEOUT", "Gaussian import exceeded 30 seconds")
    if source_format == 'splat':
        if not data or len(data) % 32:
            fail('Splat data must contain complete 32-byte records')
        count = len(data) // 32
        if count > MAX_SPLATS:
            raise PlastisError('IMPORT_TOO_COMPLEX', 'At most 2,000,000 splats are supported')
        for offset in range(0, len(data), 32):
            check_timeout(offset // 32)
            values = struct.unpack_from('<6f', data, offset)
            if not all(math.isfinite(v) for v in values) or any(v <= 0 for v in values[3:]):
                fail('Splat positions must be finite and scales positive')
            if data[offset+28:offset+32] == bytes([128]*4):
                fail('Splat rotation must be nonzero')
        return data
    end = data.find(b'end_header\n', 0, 65536)
    if end < 0:
        fail('Missing bounded PLY header')
    try:
        header = data[:end].decode('ascii', errors='strict').splitlines()
    except UnicodeDecodeError:
        fail('Gaussian PLY header must be ASCII')
    if 'format binary_little_endian 1.0' not in header:
        fail('Gaussian PLY requires binary little-endian float properties')
    count = None
    properties = []
    for line in header:
        words = line.split()
        if words[:2] == ['element', 'vertex']:
            try:
                count = int(words[2])
            except (IndexError, ValueError):
                fail('Invalid Gaussian vertex count')
        elif words[:1] == ['property']:
            if len(words) != 3 or words[1] != 'float':
                fail('Gaussian PLY requires float properties')
            properties.append(words[2])
        elif words[:1] == ['element'] and words[1] != 'vertex':
            fail('Gaussian PLY supports one vertex element')
    if count is None or count < 1 or count > MAX_SPLATS:
        raise PlastisError('IMPORT_TOO_COMPLEX', 'Gaussian count must be 1 to 2,000,000')
    required = ['x','y','z','scale_0','scale_1','scale_2','f_dc_0','f_dc_1','f_dc_2','opacity','rot_0','rot_1','rot_2','rot_3']
    if len(set(properties)) != len(properties) or not all(k in properties for k in required):
        fail('Missing or duplicate Gaussian PLY properties')
    start = end + len(b'end_header\n')
    stride = len(properties) * 4
    if len(data) - start != count * stride:
        fail('Gaussian PLY payload length does not match header')
    indices = [properties.index(k) for k in required]
    result = bytearray(count * 32)
    for i in range(count):
        check_timeout(i)
        row = struct.unpack_from('<' + 'f' * len(properties), data, start + i * stride)
        v = [row[j] for j in indices]
        if not all(math.isfinite(x) for x in v):
            fail('Gaussian properties must be finite')
        if any(abs(x) > 80 for x in v[3:6]):
            fail('Gaussian scale is outside the supported range')
        scales = [math.exp(x) for x in v[3:6]]
        q = v[10:14]
        norm = math.sqrt(sum(x*x for x in q))
        if norm < 1e-12:
            fail('Gaussian rotation must be nonzero')
        color = [round(max(0,min(1,0.5 + 0.28209479177387814*x))*255) for x in v[6:9]]
        opacity = 1/(1+math.exp(-max(-80,min(80,v[9]))))
        rotation = [max(0,min(255,round(x/norm*128+128))) for x in q]
        struct.pack_into('<6f8B', result, i*32, *v[:3], *scales, *color, round(opacity*255), *rotation)
    return bytes(result)

def is_gaussian_ply(data):
    return b'property float f_dc_0' in data[:65536] and b'property float scale_0' in data[:65536]
