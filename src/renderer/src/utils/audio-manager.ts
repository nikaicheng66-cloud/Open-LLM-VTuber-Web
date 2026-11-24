/**
 * Global audio manager for handling audio playback and interruption
 * This ensures all components share the same audio reference
 */
// [deskpet] while the mic hears something during her reply, she is turned down instead of cut off:
// the server first checks whether the sound is the PC's own speakers ("echo-ignored") or the
// user ("barge-in"); only the latter interrupts her
const DUCKED_VOLUME = 0.6;
const DUCK_MAX_MS = 10000; // longest she stays turned down waiting for a verdict

class AudioManager {
  private currentAudio: HTMLAudioElement | null = null;
  private currentModel: any | null = null;
  private ducked = false;
  /** [deskpet] heard sound during her reply, waiting for the server's verdict */
  bargeInPending = false;

  /**
   * Set the current playing audio
   */
  setCurrentAudio(audio: HTMLAudioElement, model: any) {
    this.currentAudio = audio;
    this.currentModel = model;
    audio.volume = this.ducked ? DUCKED_VOLUME : 1; // [deskpet] a sentence that starts while ducked
  }

  private duckTimer: ReturnType<typeof setTimeout> | undefined;

  /** [deskpet] turn her down (true) or back up (false).
   * Never stays down on its own: if no verdict comes (the mic was stopped mid-sentence, a
   * message got lost), she is turned back up after DUCK_MAX_MS. */
  duck(on: boolean) {
    this.ducked = on;
    clearTimeout(this.duckTimer);
    if (on) {
      this.duckTimer = setTimeout(() => {
        console.warn('[deskpet] no verdict on the sound heard during her reply - volume back up');
        this.bargeInPending = false;
        this.duck(false);
      }, DUCK_MAX_MS);
    }
    if (this.currentAudio) this.currentAudio.volume = on ? DUCKED_VOLUME : 1;
  }

  /** [deskpet] a turn started or ended: whatever was pending is over, full volume */
  resetDuck() {
    this.bargeInPending = false;
    if (this.ducked) this.duck(false);
  }

  /**
   * Stop current audio playback and lip sync
   */
  stopCurrentAudioAndLipSync() {
    if (this.currentAudio) {
      console.log('[AudioManager] Stopping current audio and lip sync');
      const audio = this.currentAudio;
      
      // Stop audio playback
      audio.pause();
      audio.src = '';
      audio.load();

      // Stop Live2D lip sync
      const model = this.currentModel;
      if (model && model._wavFileHandler) {
        try {
          // Release PCM data to stop lip sync calculation in update()
          model._wavFileHandler.releasePcmData();
          console.log('[AudioManager] Called _wavFileHandler.releasePcmData()');

          // Additional reset of state variables as fallback
          model._wavFileHandler._lastRms = 0.0;
          model._wavFileHandler._sampleOffset = 0;
          model._wavFileHandler._userTimeSeconds = 0.0;
          console.log('[AudioManager] Also reset _lastRms, _sampleOffset, _userTimeSeconds as fallback');
        } catch (e) {
          console.error('[AudioManager] Error stopping/resetting wavFileHandler:', e);
        }
      } else if (model) {
        console.warn('[AudioManager] Current model does not have _wavFileHandler to stop/reset.');
      } else {
        console.log('[AudioManager] No associated model found to stop lip sync.');
      }

      // Clear references
      this.currentAudio = null;
      this.currentModel = null;
    } else {
      console.log('[AudioManager] No current audio playing to stop.');
    }
  }

  /**
   * Clear the current audio reference (called when audio ends naturally)
   */
  clearCurrentAudio(audio: HTMLAudioElement) {
    if (this.currentAudio === audio) {
      this.currentAudio = null;
      this.currentModel = null;
    }
  }

  /**
   * Check if there's currently playing audio
   */
  hasCurrentAudio(): boolean {
    return this.currentAudio !== null;
  }
}

// Export singleton instance
export const audioManager = new AudioManager();