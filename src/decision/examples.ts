import type { DecisionRequest } from "./contract.ts";

/**
 * Prepopulated, runnable examples for each panel.
 *
 * All three share one subject, a small fictional film catalogue, so the reader
 * can compare what each primitive is good for:
 * - Noul answers several independent yes/no questions about one review.
 * - Choice sorts every film into a genre in a single request (one question per film).
 * - Score places every film on the same ordered scale so the answers can be ranked.
 *
 * Question ids are for code only; the model never sees them, so each
 * `instructions` carries the complete question. Backticked paths such as
 * `films[2]` point the model at one part of a structured state.
 */

export const noulExample: DecisionRequest<"noul"> = {
  primitive: "noul",
  state: {
    review:
      "Saw this at the Roxie last night with a packed house. The first hour drags and the score is intrusive, but the final act, where the lighthouse keeper turns out to have been the brother all along, had the whole room gasping. Not perfect, but go see it before someone ruins it for you.",
  },
  questions: {
    recommends: {
      instructions: "Does the reviewer recommend watching the film?",
    },
    reveals_ending: {
      instructions: "Does `review` reveal a plot twist or how the film ends?",
    },
    saw_in_theater: {
      instructions: "Did the reviewer watch the film in a cinema?",
      criteria: {
        true: "The review names or clearly describes a theater screening with other people present.",
        false:
          "The review describes home viewing, streaming, or does not say where the film was watched.",
      },
    },
    complains_about_music: {
      instructions: "Does the reviewer criticise the film's music or score?",
    },
  },
};

const films = [
  {
    title: "Static",
    logline:
      "A radio astronomer intercepts a signal that repeats her own voice from three years in the future, and every attempt to change what it says makes the message clearer.",
  },
  {
    title: "The Long Table",
    logline:
      "Two rival food-truck owners are forced to share a single permit for a summer, trading barbs and recipes until they fall for each other somewhere between the tacos and the last night of the season.",
  },
  {
    title: "Below the Floorboards",
    logline:
      "After moving into a farmhouse, a family hears knocking from beneath the kitchen every night at 3:12, and the knocks are learning their names.",
  },
  {
    title: "Twelve Hundred Hives",
    logline:
      "Over one season, a crew of migrant beekeepers trucks their colonies across four states, filmed as almond orchards bloom and die back.",
  },
  {
    title: "Paper Kingdom",
    logline:
      "A hand-drawn adventure about a girl who folds a city out of newspaper and must keep it standing when the headlines start to come true.",
  },
  {
    title: "Last Train to Mercer",
    logline:
      "A retired detective boards an overnight train to identify a body, only to realise the passengers are the suspects from the one case he never closed.",
  },
];

const genreQuestion = (index: number) => ({
  instructions: `Which genre best fits the film described in \`films[${index}]\`?`,
});

export const choiceExample: DecisionRequest<"choice"> = {
  primitive: "choice",
  state: { films },
  criteria: {
    science_fiction: "Speculative technology, space, time, or physics that does not exist today.",
    horror: "Built to frighten: supernatural threats, dread, or violence meant to scare.",
    romantic_comedy: "A love story told for laughs, with the relationship as the main plot.",
    documentary:
      "Non-fiction: real people and events, filmed as they happen or reconstructed from records.",
    animation: "Drawn, painted, or computer-generated imagery rather than live-action footage.",
    crime_mystery: "Solving a crime or uncovering a culprit drives the plot.",
    other: "None of the genres above describes the film well.",
  },
  questions: Object.fromEntries(films.map((_, index) => [`film_${index}`, genreQuestion(index)])),
};

const contentNotes = [
  {
    title: "Paper Kingdom",
    notes:
      "Whimsical throughout. One scene where the paper city catches a small fire; nobody is hurt and it is put out with a teacup.",
  },
  {
    title: "The Long Table",
    notes:
      "Mild swearing, a food fight, and a heated argument in which a grill is knocked over. No injuries.",
  },
  {
    title: "Last Train to Mercer",
    notes:
      "A corpse is shown briefly under a sheet. Sustained suspense in the final thirty minutes, one character is held at knifepoint, and a fall from the train is implied but not shown.",
  },
  {
    title: "Below the Floorboards",
    notes:
      "Prolonged dread, jump scares, a child is dragged under the floor, and the climax shows a mutilated body in detail.",
  },
];

const intensityQuestion = (index: number) => ({
  instructions: `How intense is the content described in \`films[${index}].notes\` for a young audience?`,
});

export const scoreExample: DecisionRequest<"score"> = {
  primitive: "score",
  state: { films: contentNotes },
  criteria: [
    "Gentle throughout: nothing frightening, violent, or upsetting.",
    "Brief mild peril, slapstick, or a single tense moment that resolves quickly.",
    "Sustained tension, several frightening scenes, or moderate violence without gore.",
    "Graphic violence, gore, or disturbing themes shown in detail.",
  ],
  questions: Object.fromEntries(
    contentNotes.map((_, index) => [`film_${index}`, intensityQuestion(index)]),
  ),
};

export const examples = {
  noul: noulExample,
  choice: choiceExample,
  score: scoreExample,
} as const;
