// Demo scripts (rendered by bench/demos.js).
export const DEMOS = [
  { name: "en-trailer-cedar", voice: "cedar", narration: "trailer", text: "In a world where every story deserves a voice… [pause 0.6s] one tool changes everything. [pause 0.4s] No API key. No studio. [pause 0.5s] Just your words… brought to life." },
  { name: "fr-conte-marin", voice: "marin", narration: "audiobook", text: "Il était une fois, au bord de la mer, une vieille horloge qui ne donnait jamais la bonne heure. [pause 0.8s] [chuchote] Un soir, quelqu'un frappa à la porte du clocher… [pause 0.6s] [surpris] C'était une enfant, une lanterne à la main !" },
  { name: "en-emotions-coral", voice: "coral", text: "[happy] We won the match! [pause 0.5s] [sad] We lost the match. [pause 0.5s] [angry] Who lost the match?! [pause 0.5s] [whispers] Shh… nobody knows about the match." },
  { name: "fr-pub-coral", voice: "coral", narration: "ad", emotion: "joy", text: "Nouveau ! [pause 0.3s] La voix de vos vidéos, en un clic, avec votre compte ChatGPT. [pause 0.3s] Essayez GPTVoice dès aujourd'hui !" },
  { name: "en-meditation-sage", voice: "sage", narration: "meditation", text: "Breathe in slowly. [pause 1.5s] And let it go. [pause 1.5s] Feel your shoulders soften, one breath at a time." },
  {
    name: "fr-dialogue",
    dialogue: "LÉA (enthousiaste): [laughs] Tu as entendu ? On peut faire parler nos films en quelques minutes !\nHUGO (sceptique): Sans clé d’API ? [sighs] Ça me paraît trop beau pour être vrai.\nLÉA: Il suffit de se connecter avec son compte ChatGPT. Le reste se fait tout seul.\nHUGO (chuchote): Bon… alors on enregistre la bande-annonce ce soir.",
    voices: { LÉA: "coral", HUGO: "ash" },
  },
  {
    name: "fr-narration-long-marin",
    voice: "marin",
    narration: "audiobook",
    text: `Chaque soir, depuis trente-sept ans, la gardienne du phare montait les cent douze marches de la tour. Elle nettoyait la lentille, vérifiait la mèche, puis allumait la lampe. Personne en ville ne connaissait son nom, mais tout le monde connaissait sa lumière.

Cette nuit-là, la tempête arriva plus tôt que prévu. Le vent hurlait contre les vitres, et la pluie frappait la porte comme une main impatiente. Elle hésita un instant, puis elle reprit sa montée, marche après marche.

Tout en haut, la radio grésilla. « Vous m'entendez ? » demanda une voix lointaine. Elle prit le micro, respira profondément, et répondit simplement : « Je suis là. Suivez la lumière. »`,
  },
];
