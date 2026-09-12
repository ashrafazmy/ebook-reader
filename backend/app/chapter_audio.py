"""Deterministic source spans and streamed PCM WAV assembly (standard library only)."""

from pathlib import Path
import os
import re
import wave
from uuid import UUID, uuid5


def split_block(block_id: str, text: str, limit: int) -> list[dict]:
    spans = []
    start = 0
    while start < len(text):
        end = min(start + limit, len(text))
        if end < len(text):
            window = text[start:end]
            sentences = list(re.finditer(r'[.!?…][\"\u201d\u2019\)]*\s+', window))
            spaces = list(re.finditer(r'\s+', window))
            boundaries = sentences or spaces
            if not boundaries:
                raise ValueError(f"A word in block {block_id} exceeds the {limit}-character chunk limit.")
            end = start + boundaries[-1].end()
        value = text[start:end]
        if value.strip():
            spans.append({"source_id": str(uuid5(UUID(block_id), f"chapter-v1:{start}:{end}")),
                          "block_id": block_id, "start_offset": start, "end_offset": end, "text": value})
        else:
            raise ValueError("A chunk contains only whitespace; unable to split without changing text.")
        start = end
    return spans


def assemble_wav(sources: list[Path], destination: Path, max_bytes: int) -> tuple[float, list[tuple[float, float]]]:
    """Decode WAV frames, require identical PCM formats, write/verify then atomically publish."""
    temporary = destination.with_suffix(".part")
    total_frames = 0
    spans = []
    audio_format = None
    try:
        with wave.open(str(temporary), "wb") as output:
            # Valid defaults let close() preserve the original error if the first input is invalid.
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(24000)
            for source in sources:
                with wave.open(str(source), "rb") as audio:
                    current = (audio.getnchannels(), audio.getsampwidth(), audio.getframerate())
                    if audio.getcomptype() != "NONE" or current[0] not in {1, 2} or current[1] not in {1, 2, 3, 4} or current[2] <= 0:
                        raise ValueError("Chapter assembly requires mono/stereo PCM WAV chunks.")
                    if audio_format is None:
                        audio_format = current
                        output.setnchannels(current[0])
                        output.setsampwidth(current[1])
                        output.setframerate(current[2])
                    elif current != audio_format:
                        raise ValueError("Chunk WAV formats differ. Completed chunks are retained; no resampling is performed.")
                    count = audio.getnframes()
                    if count <= 0 or (total_frames + count) * current[0] * current[1] + 44 > max_bytes:
                        raise ValueError("Chapter audio is empty or exceeds MAX_CHAPTER_AUDIO_BYTES.")
                    spans.append((total_frames / current[2], (total_frames + count) / current[2]))
                    remaining = count
                    while remaining:
                        take = min(remaining, 16384)
                        frames = audio.readframes(take)
                        if len(frames) != take * current[0] * current[1]:
                            raise ValueError("A cached chunk WAV is truncated.")
                        output.writeframesraw(frames)
                        remaining -= take
                    total_frames += count
        with wave.open(str(temporary), "rb") as check:
            if not total_frames or check.getnframes() != total_frames:
                raise ValueError("Assembled chapter verification failed.")
            duration = total_frames / check.getframerate()
        with temporary.open("rb") as audio_file:
            os.fsync(audio_file.fileno())
        temporary.replace(destination)
        return duration, spans
    finally:
        temporary.unlink(missing_ok=True)
