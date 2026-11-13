Feature: Plain names for the question types and fields, with the API terms as second lines

  Background:
    Given the page names each question type and each tree field in plain words first
    And the API's own word for the same thing is quieter secondary text next to the plain name
    # One term per concept, everywhere the page says it: headings, labels, hints, status sentences, and results.
    # Old term                      New term
    # Noul (panel heading)          Yes or no
    # Choice (panel heading)        Pick one option
    # Score (panel heading)         Score on a scale
    # State (tree field)            What the model reads
    # Ask for each item in          Ask once for each item in
    # Read as JSON. / Read as text. The page reads this as JSON. / The page reads this as text.
    # Choice options (legend row)   Options
    # Score levels (legend row)     Levels
    # Yes/no question (legend row)  Yes or no
    # The tree already said "options", "levels", and "yes/no meaning" for criteria, so those stay.
    And the JSON view, the JSON hint's key names, and the wire view keep the API's real keys

  # --- Panel headings --------------------------------------------------------------------------------------------------

  # Since #102 the three panel headings are the three options of the question type choice. Each option is named by
  # its plain name alone and described by what it answers and the same API term sentence
  # (scenarios/102-one-request.feature).
  Scenario: Each panel is headed by its plain name, with the API term on the next line
    Given the page
    Then the three panel headings read "Yes or no", "Pick one option", and "Score on a scale"
    And each heading is an h2 inside an hgroup, followed by a paragraph that names the API term
    And the "Yes or no" paragraph says "API term: noul in TypeSafe Jev and SubQ Snap, predicate in OpenAI Decisions."
    And the "Pick one option" paragraph says "API term: choice in every provider."
    And the "Score on a scale" paragraph says "API term: score in every provider."
    And each API term is in a <code> element

  Scenario: The API term is read after the heading without making the heading noisy
    Given a screen reader user moving through the page by headings
    Then each panel's heading and the section it names read only the plain name
    And reading on from the heading reaches the API term next
    # Decision: the term is a <p> in the heading's <hgroup>, not a <span> inside the <h2>. A span inside the h2
    # would add the term to the heading's name and to the section's aria-labelledby name, so every heading list
    # and landmark list would repeat it. The hgroup still ties the line to its heading, and the reading order puts
    # it straight after.

  Scenario: The API terms come from the vocabulary legend, so the page markup names no provider
    Given index.html
    Then the API-term paragraphs are empty in the markup
    And src/ui/request-form.ts fills each one from the legend's row for that question type
    And index.html still names no provider (the provider-neutral contract, #23)

  # --- Field labels ----------------------------------------------------------------------------------------------------

  Scenario: The tree's state field leads with a plain label and names its JSON key after it
    Given a panel showing the tree
    Then the first field is labelled "What the model reads"
    And the line under the label says "In JSON: state", with "state" in a <code> element
    And that line is the first part of the field's description, so a screen reader reads it after the label

  Scenario: Shared and per-question criteria name their JSON key
    Given a "Pick one option" panel holding the film example
    Then the shared options are headed "Shared options", and the line under the heading says "In JSON: criteria"
    And a question with its own options shows the same line under its "Options for this question" heading

  Scenario: Fan-out says it asks once per item
    Given a "Pick one option" panel whose "What the model reads" field holds a list
    Then the fan-out select is labelled "Ask once for each item in"

  Scenario: No visible heading or field label consists only of an API term
    Given the page with every panel holding the film example
    Then no panel heading or tree field label reads "Noul", "Choice", "Score", or "State"

  # --- Status sentences and results ------------------------------------------------------------------------------------

  Scenario: Sentences about a panel use its plain name without quotation marks
    Given the "Yes or no" panel holds the film example and TypeSafe Jev is selected
    Then Run's description says "Checks the Yes or no request and sends it to TypeSafe Jev."
    And a confirmation before a load asks "Load the film example for Yes or no?"
    And an error summary is headed "The request cannot be sent yet"
    # No quotation marks in accessible names or announced sentences: with punctuation reading on, a screen
    # reader can say "left double quote", and the capitalised name already marks where it starts.

  Scenario: A result heading and its status sentence use the plain name in a colon form
    When the person runs "Pick one option" on SubQ Snap
    Then the result's heading reads like "Pick one option: SubQ Snap at 14:32:05"
    And the status line says "Pick one option: SubQ Snap gave 4 answers." when four answers arrive, or "gave 1 answer." for one
    # "Score on a scale on SubQ Snap" would double "on", so the name ends with a colon. A run on several
    # providers (#101) reads "Score on a scale: TypeSafe Jev and SubQ Snap at 14:32:05".

  Scenario: The "Yes or no" description is plain
    Then the "Yes or no" panel's description reads "How likely a yes-or-no statement is to be true, judged from what the model reads."

  Scenario: Messages about the state use the same plain term
    Given a question that asks once for each item in "films", and "films" is not a list in what the model reads
    Then its issue says "What the model reads has no list called "films". Pick one of its lists, or ask once."
    And the image control says to ask about the images "in what the model reads or in a question"

  # --- The vocabulary legend -------------------------------------------------------------------------------------------

  Scenario: The legend's rows use the page's plain terms
    Given a provider is selected
    When the person opens "Words <provider> uses"
    Then its rows are named "What the model reads", "Questions", "Yes or no", "Pick one option", "Score on a scale", "Yes/no meaning", "Options", "Levels", "Probability of yes", and "A question the model declines"
    And each row still gives that provider's own word, such as "predicate" for "Yes or no" on OpenAI Decisions

  # --- The JSON view ---------------------------------------------------------------------------------------------------

  Scenario: The JSON view keeps the API's keys
    Given a "Yes or no" panel holding the film example
    When the JSON view is opened
    Then the request's keys are "primitive", "state", and "questions", as before
    And the hint under the textarea names "criteria" as a key in a <code> element
    And the wire view of a result shows each provider's own keys, unchanged

  Scenario: The request contract does not change
    Then no JSON key, data attribute, element id, or localStorage key changes
    And the Worker's validation messages, which quote JSON keys such as "state", stay as they are

  # --- Gate ------------------------------------------------------------------------------------------------------------

  Scenario: The checks pass
    When `vp check` and `vp test` run
    Then both pass
