import { describe, expect, it } from 'vitest';
import { importAudioResult, missingHelperResult, parseExtractAnswer } from './import-audio';

describe('import audio (helper --extract-audio)', () => {
  it('reads the last JSON line of the helper', () => {
    expect(parseExtractAnswer('{"type":"audio","audio":true,"converted":true,"codec":"opus","from":"aac","durationMs":1500}\n'))
      .toEqual({ audio: true, converted: true, codec: 'opus', from: 'aac', error: undefined });
    expect(parseExtractAnswer('log line\n{"type":"audio","audio":false}\n')).toMatchObject({ audio: false, converted: false });
    expect(parseExtractAnswer('{"type":"audio","audio":true,"converted":false,"codec":"opus"}')).toMatchObject({ audio: true, converted: false });
    expect(parseExtractAnswer('{"type":"audio","error":"x"}').error).toBe('x');
  });

  it('uses the converted file, reports sound that could not be converted, and ignores the rest', () => {
    const a = (line: string) => importAudioResult(parseExtractAnswer(line), 'media/r1/sound.m4a', 'audio/mp4');
    expect(a('{"type":"audio","audio":true,"converted":true,"codec":"opus","from":"aac"}'))
      .toEqual({ audio: { file: 'media/r1/sound.m4a', mime: 'audio/mp4', from: 'aac' } });
    expect(a('{"type":"audio","audio":false}')).toBeNull();
    expect(a('{"type":"audio","audio":true,"converted":false,"codec":"opus"}')).toBeNull();
    // Windows: Media Foundation has no decoder for it, or decoding failed.
    expect(a('{"type":"audio","audio":true,"converted":false,"codec":"ac3","from":"ac3","error":"no-decoder"}'))
      .toEqual({ issue: { codec: 'ac3', reason: 'no-decoder' } });
    expect(a('{"type":"audio","audio":true,"error":"Error Domain=AVFoundationErrorDomain"}'))
      .toEqual({ issue: { codec: 'unknown', reason: 'Error Domain=AVFoundationErrorDomain' } });
  });

  it('rejects anything else', () => {
    expect(() => parseExtractAnswer('{"type":"probe"}')).toThrow();
    expect(() => parseExtractAnswer('')).toThrow();
  });

  it('warns about the sound of an MP4 or MOV when the helper is missing, but not about WebM', () => {
    expect(missingHelperResult('/p/media/rec/phone.MP4')).toEqual({ issue: { codec: 'unknown', reason: 'helper-missing' } });
    expect(missingHelperResult('clip.mov')).toEqual({ issue: { codec: 'unknown', reason: 'helper-missing' } });
    expect(missingHelperResult('screen.webm')).toBeNull();
  });
});
