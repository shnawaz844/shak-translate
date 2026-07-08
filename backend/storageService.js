require('dotenv').config();
const { supabase } = require('./supabaseClient');

const BUCKET = 'audio-recordings';

/**
 * Uploads a base64-encoded WAV buffer to Supabase Storage.
 *
 * @param {string} sessionId  - App session ID (used as folder)
 * @param {string} messageId  - Unique message/turn ID
 * @param {'original'|'translated'} suffix - Track type
 * @param {string} base64Wav  - Base64 WAV audio data
 * @returns {Promise<string|null>} Public URL or null on failure
 */
async function uploadAudio(sessionId, messageId, suffix, base64Wav) {
  if (!base64Wav || base64Wav.length < 100) return null;

  try {
    const buffer = Buffer.from(base64Wav, 'base64');
    const filePath = `${sessionId}/${messageId}_${suffix}.wav`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(filePath, buffer, {
        contentType: 'audio/wav',
        upsert: false,
      });

    if (error) {
      console.error(`[storageService] Upload failed (${suffix}):`, error.message);
      return null;
    }

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(filePath);
    return data?.publicUrl ?? null;
  } catch (err) {
    console.error(`[storageService] Unexpected error uploading ${suffix}:`, err.message);
    return null;
  }
}

module.exports = { uploadAudio };
