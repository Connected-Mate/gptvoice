// Listening-test battery: the same scripts rendered by the old and new pipelines.
export const ITEMS = [
  {
    id: "01-fr-narration",
    title: "Narration FR multi-paragraphes (~45 s)",
    kind: "speech",
    opts: { voice: "marin", narration: "audiobook" },
    text: `Chaque soir, depuis trente-sept ans, la gardienne du phare montait les cent douze marches de la tour. Elle nettoyait la lentille, vérifiait la mèche, puis allumait la lampe. Personne en ville ne connaissait son nom, mais tout le monde connaissait sa lumière.

Cette nuit-là, la tempête arriva plus tôt que prévu. Le vent hurlait contre les vitres, et la pluie frappait la porte comme une main impatiente. Elle hésita un instant, puis elle reprit sa montée, marche après marche.

Tout en haut, la radio grésilla. « Vous m'entendez ? » demanda une voix lointaine. Elle prit le micro, respira profondément, et répondit simplement : « Je suis là. Suivez la lumière. »`,
  },
  {
    id: "02-en-documentary",
    title: "EN documentary (~30 s)",
    kind: "speech",
    opts: { voice: "ash", narration: "documentary" },
    text: `Off the coast of Brittany, the tides rise and fall by more than twelve metres. Twice a day, entire villages watch the sea retreat for miles, revealing a landscape of sand, rock and seaweed.

For centuries, fishermen have read these rhythms like a calendar. Today, scientists measure them with satellites, but the lesson remains the same: the ocean keeps its own time, and everything on the shore adapts to it.`,
  },
  {
    id: "03-fr-pub",
    title: "Pub FR énergique (~10 s)",
    kind: "speech",
    opts: { voice: "coral", narration: "ad", emotion: "joy" },
    text: "Nouveau ! La voix de vos vidéos, en un clic. Choisissez une voix, une émotion, un style. Et c'est prêt. Essayez GPTVoice dès aujourd'hui !",
  },
  {
    id: "04-en-emotions",
    title: "EN emotional range: calm → excited → sad (one passage)",
    kind: "speech",
    opts: { voice: "cedar" },
    text: "[calm] The letter arrived on a quiet Sunday morning. I opened it slowly, expecting nothing at all. [excited] And then I saw it: we had won! After all those years, we had actually won! [sad] But by the time I ran to tell her, the house was empty, and the only answer was the silence.",
  },
  {
    id: "05-fr-conte-chuchote",
    title: "Conte FR chuchoté avec [pause] et [chuchote]",
    kind: "speech",
    opts: { voice: "sage", narration: "kids" },
    text: "Il était une fois une petite souris qui vivait sous le plancher d'une vieille bibliothèque. [pause 1s] Chaque nuit, quand tout le monde dormait, elle sortait lire un livre. [chuchote] Mais cette nuit-là, quelqu'un avait laissé une bougie allumée… [pause 0.8s] Et dans la lumière, un chat la regardait.",
  },
  {
    id: "06-dialogue-fr-en",
    title: "Dialogue FR/EN, 2 voix, avec [laughs]",
    kind: "dialogue",
    opts: { voices: { CLAIRE: "coral", JAMES: "verse" } },
    text: `CLAIRE (amusée): [laughs] Tu as vraiment commandé un croissant en anglais ?
JAMES: I tried! I said "one croissant, please", and she answered in perfect French.
CLAIRE: Normal, on est à Paris. [laughs] La prochaine fois, dis simplement « un croissant, s'il vous plaît ».
JAMES (laughing): Un croissant, s'il vous plaît. Okay… I think I can do that.`,
  },
  {
    id: "07-clips-video",
    title: "Clips vidéo : 4 plans avec durée cible",
    kind: "clips",
    opts: { voice: "cedar", narration: "trailer" },
    lines: [
      { id: "plan-1", text: "Une ville s'éveille au bord de la mer.", target_seconds: 3.5 },
      { id: "plan-2", text: "Chaque matin, les bateaux partent avant le jour.", target_seconds: 4 },
      { id: "plan-3", text: "Mais aujourd'hui, l'un d'eux ne reviendra pas.", target_seconds: 4 },
      { id: "plan-4", text: "Le Phare. Bientôt.", target_seconds: 2.5 },
    ],
  },
  {
    id: "08-fr-long-2min",
    title: "Texte long FR (~1 min 40) — teste les jointures",
    kind: "speech",
    opts: { voice: "marin", narration: "audiobook" },
    text: `Le train de nuit quitta Paris à vingt-deux heures quinze, sous une pluie fine qui faisait briller les rails. Dans le compartiment numéro sept, une femme d'une soixantaine d'années rangeait soigneusement un vieux carnet dans son sac. Elle n'avait pas pris ce train depuis plus de trente ans.

À l'époque, elle était étudiante. Elle partait chaque été rejoindre sa grand-mère dans un petit village des Alpes, où l'on parlait encore un patois que plus personne ne comprend aujourd'hui. Elle se souvenait de l'odeur du foin, du bruit des cloches, et de ce silence immense, le soir, quand la montagne avalait toutes les lumières.

Le contrôleur passa vérifier les billets. Il remarqua le carnet, dont la couverture de cuir était usée jusqu'à la trame. « Un souvenir ? » demanda-t-il poliment. Elle sourit. « Une promesse », répondit-elle. Il n'insista pas, mais il resta un instant sur le seuil, comme s'il attendait la suite de l'histoire.

Alors elle raconta. La lettre écrite à vingt ans, jamais envoyée. Le garçon du village, qui voulait devenir guide de haute montagne. Le dernier été, la dispute idiote, le départ précipité. Et ces trente années passées à se demander ce qui serait arrivé si elle avait simplement posté cette lettre.

Le train ralentit à l'approche de Grenoble. Dehors, l'aube commençait à dessiner les sommets. Elle ouvrit le carnet à la dernière page, où l'enveloppe attendait toujours, jaunie, avec un timbre qui ne valait plus rien. « Vous allez la poster ? » demanda le contrôleur. Elle regarda la montagne, puis elle hocha la tête. « Cette fois, oui. »`,
  },
];
