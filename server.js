Base44

Voici le prompt complet à coller dans ChatGPT :

Contexte : J’ai une app de visioconférence React qui utilise LiveKit (livekit-client v2) pour les appels vidéo. J’ai aussi un hook custom qui se connecte à un backend WebSocket, capte le micro, envoie l’audio en PCM 16kHz, reçoit une transcription STT + traduction + TTS (audio MP3 base64).useInstantTalk

Le TTS est déjà joué localement via un , et est aussi disponible comme MediaStream (via ), exposé par le hook sous le nom .AudioContextAudioContext.createMediaStreamDestination()ttsStream

Ce que je veux : Quand la traduction est active, l’autre participant LiveKit doit entendre ma voix traduite (TTS) au lieu de mon micro réel.

Stack :

livekit-client v2 (, , , RoomLocalParticipantcreateLocalAudioTrackLocalAudioTrack)
Accroches de réaction
Le est un standard avec une piste audiottsStreamMediaStream
Ce que j’ai dans VideoRoom.jsx :

Une instance (objet de LiveKit) dans un ref : roomRoomroomRef.current
La piste micro locale est publiée via room.localParticipant.publishTrack(...)
Un état (booléen)isTranslationActive
Le arrive via un callback ttsStreamonTtsStream(stream)
Question / Tâche : Écris-moi la logique React complète pour :

Quand arrive ET : unpublish la piste micro locale, puis publish la piste TTS comme LiveKitttsStreamisTranslationActive === trueLocalAudioTrack
Quand repasse à : unpublish la piste TTS, puis republish le micro réelisTranslationActivefalse
Gérer proprement les refs pour éviter les double-publish
Utiliser les bonnes APIs LiveKit v2 (, , createLocalAudioTrackroom.localParticipant.publishTrackroom.localParticipant.unpublishTrack)
Donne-moi le code complet du + des fonctions helper à intégrer dans mon composant .useEffectVideoRoom

Colle ça directement dans ChatGPT et envoie-moi le code qu’il génère, je l’intègre immédiatement.
