Feature: Run one request on several providers and read the answers side by side

  # Issue #101. Comparing providers used to mean switching the provider select, running again, and remembering the
  # earlier answers. Now the Run bar has a checkbox per provider, and one press of Run asks every ticked one.

  Background:
    Given GET /api/providers lists TypeSafe Jev, SubQ Snap, and OpenAI Decisions
    And the request holds the "Yes or no" film example

  # --- Choosing providers ---------------------------------------------------------------------------------------------

  Scenario: The providers are checkboxes in the Run bar
    Then a fieldset with the legend "Providers to ask" sits in the Run bar, before Run
    And it holds one checkbox per listed provider, in list order
    And each checkbox is named by the provider and its model, such as "SubQ Snap subq-snap-preview"
    And each is described by what the provider does with images, such as "Text only, no images."
    And the fieldset is disabled, saying "Loading providers…", until the list arrives

  Scenario: The choice is remembered
    Given this viewer ticked SubQ Snap and OpenAI Decisions last time
    When the page loads
    Then those two are ticked
    And the choice is stored under "decisionmachines3000:providers" as a JSON list of ids
    # A single id stored under the old key "decisionmachines3000:provider" is the starting point once.
    # With nothing stored, the first provider is ticked. A stored empty list stays empty.

  Scenario: With nothing ticked, Run says what to do
    Given no provider is ticked
    When the person presses Run
    Then nothing is posted
    And the error summary lists "Tick at least one provider to run the request.", linked to the first checkbox

  # --- Running ----------------------------------------------------------------------------------------------------------

  Scenario: One press asks every ticked provider at the same time
    Given TypeSafe Jev and SubQ Snap are ticked
    Then Run's description says "Checks the Yes or no request and sends it to TypeSafe Jev and SubQ Snap."
    When the person presses Run
    Then both providers are asked at the same time, and Run's description says "Waiting for the answers to this request."
    And the results status says "Asking TypeSafe Jev and SubQ Snap…"
    # Decision (owner, 2026-11-13): in parallel, so one slow provider does not hold up the others. Each provider's
    # latency is measured by the Worker for its own call.

  Scenario: The result lines the answers up by question
    Given TypeSafe Jev and SubQ Snap both answered
    Then one result is headed "Yes or no: TypeSafe Jev and SubQ Snap at <time>"
    And it holds one table, captioned for screen readers "Answers by question and provider"
    And its header row reads "Question", "TypeSafe Jev", "SubQ Snap"
    And each row is headed by a question as it was asked, followed by each provider's answer to it
    And below the table each provider has its own section with its metadata sentence and its own wire view
    And the results status says "Yes or no: 2 of 2 providers answered, TypeSafe Jev and SubQ Snap."

  Scenario: A screen reader reads one question's answers together
    Given a result from two providers
    Then the question is a row header and each provider's name is a column header
    And moving along a row reads every provider's answer to that question without leaving the row
    And on a phone each row is laid out as a group, each answer labelled with its provider, and the table keeps its roles

  Scenario: One provider fails
    Given SubQ Snap answers with an error and TypeSafe Jev succeeds
    Then TypeSafe Jev's answers are in their column
    And every cell in SubQ Snap's column says "No answer"
    And SubQ Snap's section below the table holds its failure as an alert
    And the results status names only who answered: "Yes or no: 1 of 2 providers answered, TypeSafe Jev."

  # --- Images -----------------------------------------------------------------------------------------------------------

  Scenario: A text-only provider ticked beside one that takes images
    Given TypeSafe Jev and SubQ Snap are ticked and two images are attached
    Then Run's description says "Checks the Yes or no request and sends it to SubQ Snap with 2 images, and to TypeSafe Jev without them."
    When the person presses Run
    Then SubQ Snap is sent the request with the images, and TypeSafe Jev without them
    And TypeSafe Jev's metadata sentence ends "Sent without the 2 attached images."

  Scenario: The images follow the strictest limits of the ticked image providers
    Given SubQ Snap (up to 4 images) and OpenAI Decisions (up to 8) are ticked
    Then the image control's limits line has one sentence per ticked provider
    When 6 images are attached
    Then images 5 and 6 are marked over the limit
    And Run's description says "2 images are over the limits of SubQ Snap: up to 4 images, 64 KB in total. Remove the 2 marked images to run."
    # Only the providers whose limits the images exceed are named.

  Scenario: A blank state with an image is refused for a provider that gets no images
    Given TypeSafe Jev and SubQ Snap are ticked, what the model reads is blank, and an image is attached
    When the person presses Run
    Then nothing is posted
    And the error summary starts "For TypeSafe Jev, which is sent no images: "

  # --- Everything else ---------------------------------------------------------------------------------------------------

  Scenario: The request is checked against what every ticked provider accepts
    Given a Score on a scale request with 11 levels, which TypeSafe Jev refuses
    When TypeSafe Jev is ticked beside a provider that allows more levels
    Then Run lists the 10-level limit in the error summary

  Scenario: The warm demo warms one provider
    Given the Node dev host, which reports connection metrics
    Then the warm form warms the first ticked provider that can warm, and its button names that provider

  Scenario: The words each provider uses move after the results
    Then "About these providers: the words they use" is a disclosure after the Results section
    And it holds a table with a row per part of a request and a column per listed provider
