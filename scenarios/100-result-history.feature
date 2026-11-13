Feature: Every result is labelled with its question type, provider, and time, and earlier results stay on the page

  Background:
    Given the Results section has a visible h2 "Results", a status line with role="status", and an ordered list of results
    And each result is an <article> whose h3 reads "<question type>: <provider> at <time>", with the time in a <time datetime> element
    # The question type is the panel's plain name (issue #103): "Yes or no", "Pick one option", or "Score on a scale".
    And each question inside a result is an h4
    # Decisions recorded in the commit for issue #100:
    # The list keeps the newest 20 results and drops the oldest. It is not kept across reloads, so a reload starts empty.
    # A result is never marked as out of date. Its heading says what ran and when, which stays true after the panel is
    # edited or another provider is selected, so the page does not try to detect staleness.

  Scenario: The first run adds one labelled result
    Given an empty result list
    When the person runs "Yes or no" on TypeSafe Jev
    Then the list holds one result whose heading names "Yes or no", TypeSafe Jev, and the time, such as "Yes or no: TypeSafe Jev at 14:32:05"
    And the message "There are no results." is hidden and the "Clear results" button shows

  Scenario: A run on another provider keeps the earlier result
    Given the result of a "Yes or no" run on TypeSafe Jev
    When the person switches to SubQ Snap and runs "Yes or no" again
    Then the list holds two results, the SubQ Snap one first
    And both sets of answers are on the page

  Scenario: Editing the panel keeps the result
    Given the result of a "Yes or no" run on TypeSafe Jev
    When the person edits the "Yes or no" panel
    Then the result and its answers are still on the page, with the heading it had

  Scenario: A completed run is announced in one sentence
    When a "Yes or no" run on SubQ Snap completes with four answers
    Then the status line says "Yes or no: SubQ Snap gave 4 answers."
    And it does not read out the answers, which stay readable in the list

  Scenario: A failed run is announced by its alert
    When a run fails
    Then the failure is added to the list as a result with role="alert" inside it
    And the status line is empty, so the failure is not announced twice

  Scenario: The wire view belongs to its result and starts closed
    Given a result
    Then its "Sent to" and "Received from" blocks, or a failure's "Raw response" block, are inside that result's article
    And each block is closed until the person opens it
    And no live region holds any of them

  Scenario: The list keeps the newest 20 results
    Given 20 results in the list
    When another run completes
    Then the list still holds 20 results, the new one first, and the oldest is gone

  Scenario: Clearing the list
    Given several results
    When the person presses "Clear results"
    Then the list is empty and the page says "There are no results. Run the request to see its answers here."
    And the status line says "Results cleared."
    And the "Clear results" button hides, and focus moves to the "Results" heading

  # Manual step, run by the coordinator (needs vp dev, which needs 1Password).
  Scenario: Live check with a screen reader
    Given vp dev --port 5199 --strictPort is running and VoiceOver is on
    When the person runs "Yes or no" on TypeSafe Jev, then switches to SubQ Snap and runs "Yes or no" again
    Then VoiceOver says "Yes or no: SubQ Snap gave 4 answers." once, and not the answers
    And the headings rotor lists "Results", then each result's h3, newest first, with its questions as h4
