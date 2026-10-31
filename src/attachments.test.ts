import { describe, expect, test } from 'bun:test';
import {
    classifyAttachment,
    buildAudioFileName,
    buildMediaDataUrl,
    UNSUPPORTED_ATTACHMENT_MESSAGE,
    IMAGE_NOT_SUPPORTED_MESSAGE
} from './attachments';

describe('classifyAttachment', () => {
    test('an audio is always transcribed', () => {
        expect(classifyAttachment('audio/mp3', true)).toBe('audio');
        expect(classifyAttachment('audio/mp3', false)).toBe('audio');
        expect(classifyAttachment('audio/ogg; codecs=opus', false)).toBe('audio');
    });

    test('an image is forwarded when the model supports it', () => {
        expect(classifyAttachment('image/png', true)).toBe('image');
        expect(classifyAttachment('image/jpeg', true)).toBe('image');
    });

    test('an image is reported when the model does not support it', () => {
        expect(classifyAttachment('image/png', false)).toBe('image-not-supported');
    });

    test('any other format is unsupported', () => {
        expect(classifyAttachment('application/pdf', true)).toBe('unsupported');
        expect(classifyAttachment('video/mp4', true)).toBe('unsupported');
        expect(classifyAttachment('text/plain', false)).toBe('unsupported');
        expect(classifyAttachment('', true)).toBe('unsupported');
    });

    test('the MIME type is compared in lower case', () => {
        expect(classifyAttachment('AUDIO/MP3', true)).toBe('audio');
        expect(classifyAttachment('IMAGE/PNG', false)).toBe('image-not-supported');
    });
});

describe('buildAudioFileName', () => {
    test('keeps the file name of the message', () => {
        expect(buildAudioFileName('audio/mp3', 'voice-note.mp3')).toBe('voice-note.mp3');
    });

    test('derives the file name from the MIME type', () => {
        expect(buildAudioFileName('audio/mp3')).toBe('audio.mp3');
        expect(buildAudioFileName('audio/ogg')).toBe('audio.ogg');
        expect(buildAudioFileName('audio/mp4')).toBe('audio.mp4');
    });

    test('ignores the parameters of the MIME type', () => {
        expect(buildAudioFileName('audio/mp3; codecs=mp3')).toBe('audio.mp3');
    });

    test('returns an empty name when it cannot be derived', () => {
        expect(buildAudioFileName('audio/')).toBe('');
        expect(buildAudioFileName('')).toBe('');
    });
});

describe('buildMediaDataUrl', () => {
    test('builds the data URL of the attachment', () => {
        expect(buildMediaDataUrl('image/png', 'ABC')).toBe('data:image/png;base64,ABC');
        expect(buildMediaDataUrl('audio/mp3', 'XYZ')).toBe('data:audio/mp3;base64,XYZ');
    });
});

describe('messages', () => {
    test('the unsupported attachment message lists the accepted formats', () => {
        expect(UNSUPPORTED_ATTACHMENT_MESSAGE).toContain('Unsupported attachment');
        expect(UNSUPPORTED_ATTACHMENT_MESSAGE).toContain('audio');
        expect(UNSUPPORTED_ATTACHMENT_MESSAGE).toContain('image');
    });

    test('the image message tells the user what to do', () => {
        expect(IMAGE_NOT_SUPPORTED_MESSAGE).toContain('cannot process images');
        expect(IMAGE_NOT_SUPPORTED_MESSAGE).toContain('describe the image in text');
    });
});
