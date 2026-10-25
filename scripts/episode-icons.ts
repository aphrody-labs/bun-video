#!/usr/bin/env bun
import { isAbsolute, join, relative, resolve } from "node:path";

type Appearance = "story" | "recollection" | "opening";
interface Character {
  id: string;
  name: string;
  named: boolean;
  kind: string;
  color: string;
  appearances: Appearance[];
  evidence: { timeSeconds: number; file: string; note: string }[];
}

const evidence = (timeSeconds: number, note: string, file = `icons/evidence/time-${timeSeconds}.jpg`) => ({
  timeSeconds,
  file,
  note,
});
const character = (
  id: string,
  name: string,
  kind: string,
  color: string,
  appearances: Appearance[],
  proof: ReturnType<typeof evidence>[],
  named = true,
): Character => ({ id, name, named, kind, color, appearances, evidence: proof });

export const EPISODE_CHARACTERS: Character[] = [
  character(
    "goku",
    "Son Goku",
    "goku",
    "#f78a27",
    ["story", "recollection", "opening"],
    [
      evidence(350, "Cheveux noirs en pointes, tenue de travail et écharpe blanche"),
      evidence(82, "Super Saiyan au générique"),
    ],
  ),
  character(
    "goten",
    "Son Goten",
    "goten",
    "#70a8e0",
    ["story"],
    [evidence(357, "Enfant aux cheveux en pointes, gilet bleu et foulard vert dans le tracteur")],
  ),
  character(
    "chichi",
    "Chichi",
    "chichi",
    "#f3c842",
    ["story"],
    [evidence(580, "Chignon noir, ruban rose et robe jaune à la maison")],
  ),
  character(
    "mr-satan",
    "M. Satan",
    "satan",
    "#c95357",
    ["story"],
    [evidence(560, "Chevelure bouclée, moustache et veste rouge")],
  ),
  character(
    "gohan",
    "Son Gohan",
    "gohan",
    "#74b266",
    ["recollection", "opening"],
    [
      evidence(467, "Photographie du mariage : lunettes et costume blanc"),
      evidence(360, "Gi orange dans l'évocation du combat", "storyboard/frame-0360.jpg"),
      evidence(61, "Lunettes et tenue verte au générique", "icons/evidence/opening-08.jpg"),
    ],
  ),
  character(
    "videl",
    "Videl",
    "videl",
    "#e9b4d3",
    ["recollection"],
    [evidence(467, "Photographie du mariage : robe blanche, bouquet et cheveux noirs courts")],
  ),
  character(
    "beerus",
    "Beerus",
    "beerus",
    "#9770b8",
    ["story", "opening"],
    [evidence(1025, "Visage félin violet, longues oreilles et col bleu/noir"), evidence(58, "Apparition au générique")],
  ),
  character(
    "whis",
    "Whis",
    "whis",
    "#a9dfee",
    ["story"],
    [evidence(780, "Peau bleue, cheveux blancs verticaux, anneau et bâton")],
  ),
  character(
    "vegeta",
    "Vegeta",
    "vegeta",
    "#3e6bc3",
    ["story", "recollection"],
    [
      evidence(900, "Cheveux dressés et armure dans la salle de gravité", "storyboard/frame-0900.jpg"),
      evidence(363, "Aux côtés de Vegetto dans le souvenir"),
    ],
  ),
  character(
    "kaio",
    "Maître Kaio",
    "kaio",
    "#94d6d2",
    ["story"],
    [evidence(665, "Peau bleue, antennes, lunettes rondes et auréole")],
  ),
  character(
    "bubbles",
    "Bubbles",
    "bubbles",
    "#8b6548",
    ["story"],
    [evidence(790, "Singe brun auréolé près de Maître Kaio")],
  ),
  character(
    "gregory",
    "Gregory",
    "gregory",
    "#88abc6",
    ["story"],
    [evidence(790, "Petit insecte ailé auréolé à gauche de Bubbles")],
  ),
  character(
    "elder-kaio",
    "Doyen Kaio",
    "elder",
    "#aaa0c5",
    ["story"],
    [evidence(767, "Visage ridé, oreilles pointues, fine mèche blanche et Potara")],
  ),
  character(
    "kibitoshin",
    "Kibitoshin",
    "kibitoshin",
    "#c4b0df",
    ["story"],
    [evidence(759, "Fusion aux longs cheveux blancs, à gauche du Doyen", "icons/evidence/time-759-full.jpg")],
  ),
  character(
    "piccolo",
    "Piccolo",
    "piccolo",
    "#76af58",
    ["recollection", "opening"],
    [
      evidence(360, "Peau verte, turban et cape blanche dans le souvenir", "storyboard/frame-0360.jpg"),
      evidence(61, "Aux côtés de Gohan au générique", "icons/evidence/opening-08.jpg"),
    ],
  ),
  character(
    "gotenks",
    "Gotenks",
    "gotenks",
    "#e3c64d",
    ["recollection"],
    [evidence(360, "Fusion Super Saiyan 3, longue chevelure dorée et gilet", "storyboard/frame-0360.jpg")],
  ),
  character(
    "vegetto",
    "Vegetto",
    "vegetto",
    "#3e72bd",
    ["recollection"],
    [evidence(363, "Fusion avec Potara et gi bleu devant Vegeta")],
  ),
  character(
    "freezer",
    "Freezer",
    "freezer",
    "#b59cd4",
    ["recollection"],
    [evidence(235, "Forme finale blanche à plaques violettes face à Goku")],
  ),
  character(
    "cell",
    "Cell",
    "cell",
    "#7da44c",
    ["recollection"],
    [evidence(246, "Carapace verte tachetée, crête bifide et ailes noires")],
  ),
  character(
    "buu",
    "Majin Buu",
    "buu",
    "#df7ca8",
    ["recollection"],
    [evidence(295, "Forme originelle rose, tentacule sur la tête et poignets noirs")],
  ),
  character(
    "alien-king",
    "Roi extraterrestre",
    "alien-king",
    "#8da449",
    ["story"],
    [evidence(735, "Souverain vert à défenses et couronne ; aucun nom personnel confirmé")],
    false,
  ),
  character(
    "alien-chef-gray",
    "Cuisinier extraterrestre gris",
    "chef-gray",
    "#8f9ba8",
    ["story"],
    [evidence(713, "Cuisinier au premier plan : peau grise, oreilles pointues, toque et foulard rouge")],
    false,
  ),
  character(
    "alien-chef-green",
    "Cuisinier extraterrestre vert",
    "chef-green",
    "#819451",
    ["story"],
    [evidence(713, "Second cuisinier : peau verte, toque et foulard rouge")],
    false,
  ),
  character(
    "alien-attendants",
    "Serviteurs extraterrestres",
    "attendant",
    "#bcc5cd",
    ["story"],
    [evidence(713, "Serviteurs pâles en tenue sombre à l'arrière-plan ; groupe sans noms confirmés")],
    false,
  ),
  character(
    "alien-warrior",
    "Guerrier reptilien",
    "warrior",
    "#65939c",
    ["story"],
    [evidence(960, "Grand guerrier bleu reptilien parmi les arbres", "storyboard/frame-0960.jpg")],
    false,
  ),
  character(
    "alien-villagers",
    "Habitants extraterrestres verts",
    "villager",
    "#75b298",
    ["story"],
    [evidence(945, "Groupe vert à petite corne portant des armes de pierre ; noms non confirmés")],
    false,
  ),
];

const outline = "#252534";
const skin = "#f3c1a1";
const path = (d: string, fill: string, extra = "") => `<path d="${d}" fill="${fill}" ${extra}/>`;
const ellipse = (x: number, y: number, rx: number, ry: number, fill: string, extra = "") =>
  `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}" ${extra}/>`;
const eyes = (color = outline, angry = false) =>
  `<path d="M90 124 Q101 ${angry ? 132 : 114} 111 124 M145 124 Q155 ${angry ? 132 : 114} 166 124" fill="none" stroke="${outline}" stroke-width="5"/>` +
  ellipse(102, 130, 4, 6, color, 'stroke="none"') +
  ellipse(154, 130, 4, 6, color, 'stroke="none"') +
  '<path d="M124 138 120 147 129 149 M115 164 Q128 173 143 164" fill="none" stroke-width="3"/>';
const head = (fill = skin) => ellipse(128, 125, 47, 60, fill) + eyes();
const body = (fill: string, trim = "#e6e8ed") =>
  path("M56 240v-18q0-36 40-46l32 21 32-21q40 10 40 46v18Z", fill) + path("m97 178 31 19 32-19-14 36h-37Z", trim);
const spiky = (fill = "#25252d", small = false) =>
  path(
    small
      ? "M83 114 64 102 84 93 71 73 99 80 101 51 122 71 143 47 146 76 177 62 168 92 192 96 168 114 160 86 134 103 119 88 94 113Z"
      : "M79 114 50 94 82 85 65 57 103 72 103 29 132 61 154 20 159 65 193 44 176 83 212 87 171 114 161 87 137 106 120 88 92 113Z",
    fill,
  );
const earrings = () => ellipse(78, 149, 5, 8, "#e7bf52") + ellipse(178, 149, 5, 8, "#e7bf52");

function drawing(character: Character): string {
  const kind = character.kind;
  if (["goku", "goten", "gohan", "vegeta", "vegetto", "gotenks"].includes(kind)) {
    const colors: Record<string, string> = {
      goku: "#f78a27",
      goten: "#74ade1",
      gohan: "#78a768",
      vegeta: "#3f64b7",
      vegetto: "#3d73be",
      gotenks: "#ede2a3",
    };
    let image = body(colors[kind]!, kind === "goku" || kind === "vegetto" ? "#214f82" : "#e8edf2") + head();
    if (kind === "vegeta")
      image += path(
        "M81 111 70 91 82 96 70 62 99 84 108 28 130 65 152 28 165 84 187 60 177 103 170 112 150 81 129 111 108 81Z",
        "#24252e",
      );
    else if (kind === "gohan")
      image +=
        path("M79 110 85 71 102 76 107 42 126 67 148 31 152 73 176 59 177 108 150 81 129 103 111 81Z", "#27252b") +
        '<g fill="none" stroke-width="3"><rect x="83" y="116" width="36" height="25" rx="5"/><rect x="139" y="116" width="36" height="25" rx="5"/><path d="M119 122h20"/></g>';
    else if (kind === "gotenks")
      image =
        path(
          "M66 205 58 130 74 49 98 83 115 22 136 56 161 21 178 78 201 49 202 197 179 219 161 170 88 171Z",
          "#e6c948",
        ) +
        image +
        spiky("#e6c948") +
        path("M71 196 90 180 91 223 74 218 M166 180 185 196 181 219 163 223", "#29303d");
    else image += spiky("#27262e", kind === "goten");
    if (kind === "goten") image += path("m99 176 29 13 31-13-13 29-18-8-17 12Z", "#66a553");
    if (kind === "vegetto") image += earrings();
    if (kind === "vegeta")
      image +=
        path("M80 210h96v30H80Z", "#e6e8e7") +
        '<path d="M80 222h96 M115 210v30 M141 210v30" fill="none" stroke-width="2"/>';
    return image;
  }
  if (kind === "chichi" || kind === "videl" || kind === "satan") {
    let image = kind === "chichi" ? ellipse(128, 62, 29, 31, "#272530") : "";
    if (kind === "satan")
      image +=
        '<g fill="#2c252b">' + [78, 100, 125, 151, 177].map(x => ellipse(x, 75, 24, 29, "#2c252b")).join("") + "</g>";
    image +=
      body(
        kind === "chichi" ? "#f1ca45" : kind === "videl" ? "#f7f1f0" : "#c85459",
        kind === "satan" ? "#e0ba8a" : "#edeef3",
      ) + head();
    image += path(
      kind === "satan"
        ? "M81 116 72 91 90 65 109 74 127 65 144 76 162 65 183 91 172 120 163 91 140 93 128 110 112 91 89 99Z"
        : kind === "chichi"
          ? "M80 119q-9-67 48-67t47 67l-14-23q-29 14-57-1Z"
          : "M76 151 69 88q12-45 59-42t55 45l-1 70-15-8-8-59-27 18-35-19-9 55Z",
      "#2d2934",
    );
    if (kind === "satan")
      image +=
        path("M99 153q11-17 29-8 20-9 32 8l-15 7-17-7-15 8Z", "#32262b") +
        path("M118 179h21l-4 15h-13Z", "#32262b") +
        path("M114 200 127 195 139 200 139 213 128 208 113 212Z", "#463343");
    if (kind === "chichi") image += '<path d="M99 56q31-16 58 2" fill="none" stroke="#e6a0c7" stroke-width="8"/>';
    if (kind === "videl")
      image +=
        '<g fill="#eda4c6" stroke="none">' +
        [108, 122, 137, 150].map((x, i) => ellipse(x, 217 + (i % 2) * 5, 12, 12, "#eda4c6")).join("") +
        "</g>";
    return image;
  }
  if (kind === "beerus")
    return (
      body("#238cb8", "#282632") +
      path("M91 100 78 26q7-18 20 0l24 61 15 2 22-65q10-17 17 1l-8 77q15 55-39 79-58-26-38-81Z", "#9872ad") +
      path("M89 38 103 92 94 84 M163 40 146 91 157 82", "#654b83") +
      path("m93 119 23 7-15 9Z m71 0-22 7 14 9Z", "#e7c855") +
      '<path d="m121 144 7 6 7-6 M128 150v9 M116 162q12 8 24 0" fill="none" stroke-width="3"/>' +
      path("m80 183 48 12 48-12-6 33-42 15-42-15Z", "#252735") +
      '<path d="m92 187 19 27m53-27-19 27" stroke="#5db9df" fill="none" stroke-width="8"/>' +
      path("m128 200 9 12-9 12-9-12Z", "#e99a3c")
    );
  if (kind === "whis")
    return (
      body("#7e264b", "#28313e") +
      head("#c4e1f6") +
      path("M87 104 77 64 105 49 100 19 121 36 133 8 145 29 157 19 164 55 172 80 163 105 149 79 119 77Z", "#eef1ec") +
      '<path d="M95 79q34-14 63 2 M111 67l8-25 M135 68l1-29 M149 68l-3-22" fill="none" stroke="#b8c2ca" stroke-width="3"/>' +
      ellipse(128, 181, 61, 17, "none", 'stroke="#88d3e7" stroke-width="8"') +
      '<path d="M201 96v146" stroke="#78c3d9" stroke-width="6"/>' +
      ellipse(201, 95, 12, 15, "#313743") +
      path("m192 114 9 27 9-27Z", "#e5ca69")
    );
  if (["kibitoshin", "elder", "piccolo"].includes(kind)) {
    const face = kind === "piccolo" ? "#77ad60" : kind === "elder" ? "#aaa0c3" : "#c4b1db";
    let image =
      kind === "kibitoshin"
        ? path("M79 109 66 128 53 176 75 174 66 212 87 201 174 200 193 213 179 165 188 111Z", "#e0e5e4")
        : "";
    image +=
      body(kind === "piccolo" ? "#68458d" : "#3e99aa", kind === "piccolo" ? "#eff0e9" : "#ab534b") +
      path("m84 119-29-18 15 40 17 8 M171 119l29-18-15 40-17 8", face) +
      head(face);
    if (kind === "kibitoshin") image += path("M77 112q-6-45 37-60l42 2 26 34-21-10-11 7-18-15-33 25Z", "#e7e8e9");
    if (kind === "elder")
      image +=
        path("m108 64 4-17 13 14 9-18 9 23Z", "#e1e1e7") +
        '<path d="M90 110h28m23 0h24 M92 137l21 6m29 0 19-6 M109 155l-9 15m47-15 9 15 M111 181h28" fill="none" stroke-width="2"/>';
    if (kind === "piccolo")
      image +=
        path("M77 101 83 76 103 56h52l23 23 2 22-39-15-44 7Z", "#eeeede") +
        '<path d="M87 79h75 M96 68h59 M84 89h57" stroke="#b7bbae" fill="none" stroke-width="3"/>';
    else image += earrings();
    return image;
  }
  if (kind === "kaio")
    return (
      body("#982f54", "#d6b95e") +
      ellipse(128, 134, 66, 66, "#99d9db") +
      path("M80 124 55 105l13 45 13 3 M173 125l26-21-12 49-14 1", "#99d9db") +
      path("M79 101q11-35 50-34 44 0 50 40l-27-16-24 16-22-17Z", "#30323a") +
      '<path d="M109 76 95 37 M145 75l16-38" fill="none" stroke-width="5"/>' +
      ellipse(104, 129, 18, 18, "#25303a") +
      ellipse(153, 129, 18, 18, "#25303a") +
      '<path d="M122 128h13" stroke-width="5"/>' +
      ellipse(128, 176, 20, 15, "#bf6776") +
      ellipse(128, 31, 49, 8, "none", 'stroke="#eed891" stroke-width="5"') +
      '<path d="m89 153-27 6m105-6 27 6" fill="none" stroke-width="3"/>'
    );
  if (kind === "bubbles")
    return (
      body("#694a3e", "#926548") +
      ellipse(71, 127, 21, 28, "#966e57") +
      ellipse(185, 127, 21, 28, "#966e57") +
      ellipse(128, 119, 53, 59, "#654737") +
      ellipse(128, 138, 37, 43, "#b08a69") +
      eyes() +
      ellipse(128, 152, 12, 8, "#493b32") +
      ellipse(128, 43, 37, 7, "none", 'stroke="#eed891" stroke-width="5"')
    );
  if (kind === "gregory")
    return (
      body("#7394bc", "#d2dce3") +
      path("M101 164 54 129 36 169 83 212 M156 166l48-37 17 41-46 43", "#b3c9dc") +
      ellipse(128, 120, 43, 48, "#93b8d6") +
      ellipse(104, 118, 16, 24, "#e9f0ef") +
      ellipse(150, 118, 16, 24, "#e9f0ef") +
      eyes() +
      '<path d="M111 78 100 51m42 26 13-26 M92 186l-36 43m103-41 39 42" fill="none" stroke-width="5"/>' +
      ellipse(128, 32, 37, 7, "none", 'stroke="#eed891" stroke-width="5"')
    );
  if (kind === "freezer")
    return (
      body("#e9e8f0", "#864db5") +
      ellipse(128, 125, 50, 63, "#e8e5ee") +
      ellipse(128, 87, 35, 25, "#9a58b6") +
      path("M82 111h20l-8 43-9-16 M173 111h-20l8 43 9-16", "#b39aca") +
      eyes("#d04575", true)
    );
  if (kind === "cell")
    return (
      body("#a3b460", "#343c40") +
      path("M77 124 87 27 124 64l41-37 14 101-20 40-29 20-31-20Z", "#81a851") +
      path("M98 107h58l9 43-35 35-34-35Z", "#c2be88") +
      path("M106 62h44l7 40h-56Z", "#2d3434") +
      eyes("#a44684", true) +
      '<g stroke="none" fill="#42583d">' +
      [
        [90, 74],
        [94, 91],
        [161, 71],
        [166, 90],
        [83, 137],
        [174, 134],
        [86, 211],
        [175, 215],
      ]
        .map(([x, y]) => ellipse(x!, y!, 4, 6, "#42583d"))
        .join("") +
      "</g>"
    );
  if (kind === "buu")
    return (
      body("#df8daf", "#30333d") +
      head("#e08fb1") +
      path("M116 70q-8-57 38-45 27 8 20 26-6 8-12-3 0-13-13-10-13 2-13 32Z", "#e08fb1") +
      '<path d="m91 116 25 7m28 0 23-7" stroke="#502642" stroke-width="6"/>' +
      path("M89 210h79v18H89Z", "#d9bb57") +
      '<path d="m117 224 2-10 9 7 9-7 2 10" fill="none" stroke="#3d3542" stroke-width="3"/>'
    );
  if (kind === "alien-king")
    return (
      body("#af464c", "#d9c477") +
      head("#9caf64") +
      path("M90 116 64 85l10 52 M166 116l26-31-10 52", "#9caf64") +
      ellipse(128, 151, 28, 21, "#aabe79") +
      ellipse(117, 152, 5, 6, "#3c4535") +
      ellipse(139, 152, 5, 6, "#3c4535") +
      path("M100 163q-31-8-29-35 12 14 30 14 M156 164q31-9 29-36-12 15-30 14", "#eee5c4") +
      path("M80 78 78 53l22 10 16-30 14 28 16-27 13 28 20-11-3 30Z", "#d4b452") +
      path("M84 70h88v16H84Z", "#745194")
    );
  if (kind.startsWith("chef"))
    return (
      body("#e7e8de", "#b85559") +
      head(kind === "chef-gray" ? "#96a3ac" : "#8a9b62") +
      path("M83 82 76 53q-7-25 18-24 12-20 34-9 22-11 34 9 23-1 18 24l-6 29Z", "#e8ece8") +
      '<path d="M85 71h86 M97 43l6 17m25-26v25m27-16-6 17" fill="none" stroke="#a7b4b3" stroke-width="3"/>' +
      path("M117 166h21l-6 17h-10Z", "#464b4f") +
      path("m98 187 29 6 32-6-13 19-18-8-16 10Z", "#c44851")
    );
  if (kind === "attendant")
    return (
      body("#553145", "#caafa2") +
      head("#c4cdd1") +
      path("M79 105 83 70 99 49l24 14 17-21 23 17 11 37-15-13-33 12-22-14Z", "#6b7a85")
    );
  if (kind === "warrior")
    return (
      body("#668f9a", "#d5d6bf") +
      path("M80 161 73 97l26-32 8-23 20 9 26-5 18 33 16 34-12 51-47 26Z", "#658b97") +
      ellipse(128, 148, 42, 26, "#729eaa") +
      eyes("#daab55", true) +
      path("M93 160q36 15 70-2l-8 23H102Z", "#433b44") +
      path("m105 167 6 9 7-7 10 10 8-10 8 7 9-10", "#efe7d2") +
      '<path d="M79 110 54 91l8 30 15 9m99-20 24-19-8 30-15 9" fill="#658b97"/>'
    );
  return (
    body("#71ad95", "#8abb9b") +
    ellipse(128, 127, 69, 67, "#75ad95") +
    path("m117 64 11-31 13 32", "#75ad95") +
    ellipse(102, 129, 16, 20, "#eff2ea") +
    ellipse(155, 127, 16, 20, "#eff2ea") +
    eyes() +
    '<path d="M115 168q14 12 29 0" fill="none" stroke-width="5"/>' +
    '<path d="M198 154v82" fill="none" stroke="#846b4c" stroke-width="8"/>' +
    path("m188 131 11-9 14 13-9 16-21-3Z", "#b3ad9a")
  );
}

export function characterSvg(character: Character): string {
  const title = character.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-labelledby="title"><title id="title">${title}</title><circle cx="128" cy="128" r="124" fill="#1b2230"/><circle cx="128" cy="128" r="117" fill="${character.color}" fill-opacity=".2" stroke="${character.color}" stroke-width="2"/><g stroke="${outline}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${drawing(character)}</g></svg>\n`;
}

export async function episodeIconsMain(args = Bun.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log(
      "bun scripts/episode-icons.ts [--episode-root ignored-package-episode-directory]\nOriginal SVG pictograms and visually evidenced character catalog for Beerus episode 1.",
    );
    return;
  }
  if (args.length && (args.length !== 2 || args[0] !== "--episode-root")) throw new Error("Invalid icon option");
  const localRoot = resolve(import.meta.dir, "../.local");
  const root = resolve(args[1] ?? join(localRoot, "episodes/beerus-01"));
  const relativeRoot = relative(localRoot, root);
  if (!relativeRoot || relativeRoot.startsWith("..") || isAbsolute(relativeRoot))
    throw new Error("Icons must stay under this package's ignored .local directory");
  for (const entry of EPISODE_CHARACTERS) {
    for (const proof of entry.evidence) {
      if (!(await Bun.file(join(root, proof.file)).exists()))
        throw new Error(`Missing visual evidence for ${entry.id}`);
    }
    await Bun.write(join(root, "icons", `${entry.id}.svg`), characterSvg(entry));
  }
  const catalog = {
    schemaVersion: 1,
    episodeId: "beerus-01",
    generatedAt: new Date().toISOString(),
    style: "Original hand-drawn vector pictograms; not screenshot vectorization",
    coverage:
      "Story, explicit recollections and inspected opening; targeted visual samples, not a claim to exhaustive face detection across all frames",
    namedCount: EPISODE_CHARACTERS.filter(entry => entry.named).length,
    unnamedRolesCount: EPISODE_CHARACTERS.filter(entry => !entry.named).length,
    characters: EPISODE_CHARACTERS.map(entry => ({ ...entry, icon: `icons/${entry.id}.svg`, visuallyConfirmed: true })),
    excluded: [
      {
        name: "Shin et Kibito séparés",
        reason: "La scène de thé montre leur fusion Kibitoshin, pas deux apparitions individuelles",
      },
      { name: "Personnages seulement mentionnés", reason: "Aucune icône sans présence visuelle confirmée" },
    ],
  };
  await Bun.write(join(root, "characters.json"), JSON.stringify(catalog, null, 2) + "\n");
  console.log(
    JSON.stringify({
      status: "complete",
      icons: EPISODE_CHARACTERS.length,
      named: catalog.namedCount,
      unnamedRoles: catalog.unnamedRolesCount,
    }),
  );
}

if (import.meta.main) await episodeIconsMain();
