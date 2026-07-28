# localchune — MIT licensed. See LICENSE.
# Synthetic beat-tracking fixtures. No copyrighted audio enters the repo.
import math, struct, wave

def render(path: str, bpm: float, dur: float = 360.0, sr: int = 44100) -> None:
    spb = 60.0 / bpm
    n = int(dur * sr)
    buf = [0.0] * n
    for i in range(int(dur / spb)):                       # kick
        st = int(i * spb * sr)
        for j in range(int(0.12 * sr)):
            if st + j >= n: break
            e = math.exp(-j / (0.035 * sr))
            f = 110 * math.exp(-j / (0.012 * sr)) + 45
            buf[st + j] += 0.9 * e * math.sin(2 * math.pi * f * j / sr)
    for i in range(int(dur / (spb / 2))):                 # offbeat hat
        st = int((i * spb / 2 + spb / 2) * sr)
        for j in range(int(0.04 * sr)):
            if st + j >= n: break
            e = math.exp(-j / (0.008 * sr))
            buf[st + j] += 0.25 * e * ((j * 2654435761) % 1000 / 500.0 - 1)
    for i in range(n):                                    # bass
        buf[i] += 0.12 * math.sin(2 * math.pi * (55 if (i // (sr * 2)) % 2 == 0 else 65) * i / sr)
    w = wave.open(path, 'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
    w.writeframes(b''.join(
        struct.pack('<hh', *(int(max(-1, min(1, s)) * 30000),) * 2) for s in buf))
    w.close()

if __name__ == '__main__':
    for bpm in (128, 174):
        render(f'fixtures/beat{bpm}.wav', bpm)
