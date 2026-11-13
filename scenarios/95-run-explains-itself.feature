Feature: Run says why it cannot run, and stays reachable by keyboard

  Background:
    Given each panel's Run button is never disabled for a reason the person can act on
    And while a panel is untouched, Run's aria-describedby points at the panel's empty-state message, and no note shows under Run
    And once the panel is edited, Run's aria-describedby points at a sentence under it that says what Run will send, or why it cannot
    And each panel has an error summary at the top of its form, a box with tabindex="-1" that is empty, and hidden, until a press of Run sends nothing
    # The summary follows the GOV.UK error summary pattern: a heading, then one link per problem, and each link moves
    # focus to the control the problem is about. A problem no one control can fix, such as a request the shared
    # validator refuses as a whole, or no provider while the provider select is disabled, is listed without a link.
    And every press that shows the summary moves focus to it, which makes a screen reader read it
    # The summary is not a role="alert" live region: an alert and the focus move would read the same problems twice.
    And the panel's status line no longer repeats Run's problems

  # --- Reaching Run ---------------------------------------------------------------------------------------------------

  Scenario: Run in an untouched panel is in the tab order and says why it cannot run yet
    Given an untouched panel
    When a keyboard user tabs through it
    Then Run receives focus
    And its description is the empty-state message, "The request is empty. Load an example above, or write what the model reads and a question."
    And no note shows under Run, so the page does not say the same thing twice

  Scenario: Run in a ready panel says what it will send
    Given the "Yes or no" panel holds the film example, two images are attached, and SubQ Snap is selected
    Then Run's description says "Checks the Yes or no request and sends it to SubQ Snap with 2 images."
    When the provider changes to TypeSafe Jev, which is text only
    Then Run's description says "Checks the Yes or no request and sends it to TypeSafe Jev without your 2 images."

  # --- Pressing Run when nothing can be sent -------------------------------------------------------------------------

  Scenario: Pressing Run in an untouched panel shows the summary and moves focus to it
    Given an untouched panel
    When the person presses Run
    Then nothing is posted
    And an error summary appears at the top of the panel, headed "The request cannot be sent yet"
    And it lists "Load an example or write a question to run the request.", linked to "Load film example"
    And focus moves to the summary
    When the person follows the link
    Then focus moves to "Load film example"

  Scenario: The summary lists every reason at once
    Given an untouched panel and no provider selected
    When the person presses Run
    Then the summary lists the empty panel and the missing provider
    And the provider problem links to the provider select while the select can take focus, and is plain text while it is disabled

  Scenario: Images over the provider's limits
    Given a panel whose images are over the provider's limits
    When the person presses Run
    Then nothing is posted
    And the summary lists the image problem, as the image control's notice words it
    And the problem links to the image control's file input
    And focus moves to the summary

  Scenario: Images still being added
    Given an image is still being added to a panel
    When the person presses Run
    Then nothing is posted
    And the summary lists "Images are still being added. Run is available once they are.", linked to the file input
    When the image is in
    Then the summary drops that problem

  Scenario: Problems in the request itself are listed, and the summary takes focus
    Given a panel whose tree has two questions without instructions
    When the person presses Run
    Then nothing is posted
    And the summary lists both problems, each linked to its own question's instructions
    And the inline issue slots beside each question show the same messages as before
    And focus moves to the summary
    When the person follows the first link
    Then focus moves to the first question's instructions

  Scenario: A JSON error is listed, and its link leads to the textarea
    Given the JSON view holds text that is not valid JSON
    When the person presses Run
    Then the error under the textarea shows as before
    And the summary lists the same message, linked to the textarea
    And focus moves to the summary
    When the person follows the link
    Then focus moves to the textarea

  # --- Keeping the summary honest ------------------------------------------------------------------------------------

  Scenario: Fixing a problem drops it from the summary
    Given the summary lists two problems
    When the person fixes one of them
    Then the summary lists only the other
    And a problem that appears while the person edits is not added until Run is pressed again

  Scenario: A provider change updates a listed limit in place
    Given the summary lists "at most 10" levels for a "Score on a scale" request
    When the provider changes to one whose limit is 6
    Then the summary lists "at most 6" instead
    And focus stays where it was

  Scenario: A valid request posts and shows no summary
    Given a valid request
    When the person presses Run
    Then the request is posted
    And no summary is shown, and a summary from an earlier press is cleared

  # --- While a run is in flight --------------------------------------------------------------------------------------

  Scenario: Run is aria-disabled, not disabled, while a run is in flight
    # Since #102 there is one Run, so the sentence for the other panels below no longer exists
    # (scenarios/102-one-request.feature).
    Given the "Yes or no" panel's run is in flight
    Then every panel's Run has aria-disabled="true" and is not disabled
    And the pressed Run keeps focus
    And its description says "Waiting for the answer to this request."
    And the other panels' Run descriptions say "The Yes or no panel is running. Run is available again once its answer arrives."
    And a press of any Run meanwhile does nothing
    # aria-disabled keeps the button focused and in the tab order, so focus is not dropped to the page body and the
    # description can say why the press is ignored. The provider select's Retry button already works this way.

  Scenario: The gate
    When the change is ready
    Then `vp check` and `vp test` pass
