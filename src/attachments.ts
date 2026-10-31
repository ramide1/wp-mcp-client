/**
 * Handling of the attachments received in a WhatsApp message.
 *
 * Only images and audio are accepted. The logic is kept in a dedicated module
 * (instead of `main.ts`) so the accepted formats and the built payloads can be
 * unit tested.
 */

/** Message returned when the attachment is not an image nor an audio. */
export const UNSUPPORTED_ATTACHMENT_MESSAGE =
    'Unsupported attachment, only images and audio in flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, or webm format are accepted';

/** Message returned when the model cannot process the image that was received. */
export const IMAGE_NOT_SUPPORTED_MESSAGE =
    'The configured model cannot process images. Please describe the image in text or send it again as text.';

/** How an attachment has to be handled. */
export type AttachmentKind =
    /** The audio has to be transcribed. */
    | 'audio'
    /** The image can be forwarded to the model. */
    | 'image'
    /** The image was received but the model does not support images. */
    | 'image-not-supported'
    /** The format is not supported. */
    | 'unsupported';

/**
 * Classify an attachment by its MIME type.
 *
 * @param mimeType MIME type of the attachment
 * @param modelSupportsImage Whether the configured model accepts images
 */
export const classifyAttachment = (mimeType: string, modelSupportsImage: boolean): AttachmentKind => {
    const type = (mimeType ?? '').toLowerCase();
    if (type.startsWith('audio/')) return 'audio';
    if (type.startsWith('image/')) return modelSupportsImage ? 'image' : 'image-not-supported';
    return 'unsupported';
};

/**
 * Build the file name advertised to the transcription API.
 *
 * WhatsApp does not always provide one, so it is derived from the MIME type
 * (`audio/mp3` -> `audio.mp3`).
 */
export const buildAudioFileName = (mimeType: string, fileName?: string): string => {
    if (fileName) return fileName;
    const extension = (mimeType ?? '').split('/')[1]?.split(' ')[0]?.replace(';', '') ?? '';
    return extension !== '' ? 'audio.' + extension : '';
};

/**
 * Build the data URL of an attachment, as expected by the chat completions API.
 */
export const buildMediaDataUrl = (mimeType: string, base64Data: string): string =>
    `data:${mimeType};base64,${base64Data}`;
