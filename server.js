// refs existantes supposées
const micTrackRef = useRef(null);
const ttsTrackRef = useRef(null);
const isMicPublishedRef = useRef(false);
const isTtsPublishedRef = useRef(false);

// --------------------
// SWITCH → TTS
// --------------------
async function switchAudioToTts(ttsStream) {
  if (!roomRef.current) return;

  const ttsTrack = ttsStream?.getAudioTracks?.()[0];
  if (!ttsTrack) return;

  // Unpublish mic
  if (micTrackRef.current && isMicPublishedRef.current) {
    await roomRef.current.localParticipant.unpublishTrack(micTrackRef.current);
    isMicPublishedRef.current = false;
  }

  // Remove old TTS if exists
  if (ttsTrackRef.current && isTtsPublishedRef.current) {
    await roomRef.current.localParticipant.unpublishTrack(ttsTrackRef.current);
    isTtsPublishedRef.current = false;
  }

  ttsTrackRef.current = ttsTrack;

  await roomRef.current.localParticipant.publishTrack(ttsTrack, {
    source: "microphone",
  });

  isTtsPublishedRef.current = true;
}

// --------------------
// SWITCH → MICRO
// --------------------
async function switchAudioToMic() {
  if (!roomRef.current) return;

  // Remove TTS
  if (ttsTrackRef.current && isTtsPublishedRef.current) {
    await roomRef.current.localParticipant.unpublishTrack(ttsTrackRef.current);
    isTtsPublishedRef.current = false;
  }

  // Republish mic
  if (micTrackRef.current && !isMicPublishedRef.current) {
    await roomRef.current.localParticipant.publishTrack(micTrackRef.current, {
      source: "microphone",
    });
    isMicPublishedRef.current = true;
  }
}
