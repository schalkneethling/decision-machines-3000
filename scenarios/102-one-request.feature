Feature: One request with a question type choice, instead of three panels

  # Issue #102. The page used to repeat the whole request editor once per question type: three panels, each with its
  # own examples, Tree and JSON switch, image control, status line, error summary, and Run. The audit measured 101 tab
  # stops and a 13,000 px tall phone page. Now one form holds the request, and a radio group chooses its type.
  #
  # Older scenario files still say "panel". Read "the panel" as the request form with that question type chosen; the
  # sentences they quote are kept current. Where an older scenario depended on two panels existing side by side, a
  # comment there points here.

  Background:
    Given the page
    Then it has one request form, headed "Request", and one Results section after it
    And the first tab stop is a "Skip to results" link that moves focus to the Results heading

  # --- The question type ----------------------------------------------------------------------------------------------

  Scenario: The question type is one group of native radios
    Then a fieldset with the legend "Question type" holds three radios: "Yes or no", "Pick one option", and "Score on a scale"
    And the group is one tab stop, and the arrow keys move and choose
    And each radio is named by its plain name alone
    And each radio is described by what the type answers and by its API term, such as "API term: choice in every provider."
    And the form opens on "Yes or no", or on the type this viewer chose last

  Scenario: Changing the type keeps what the model reads and the images
    Given the "Pick one option" film example is loaded and two images are attached
    When the person chooses "Yes or no"
    Then "What the model reads" still holds the film catalogue
    And the two images are still attached
    And "Yes or no" shows its own questions, which are none yet
    And nothing is announced beyond the radio itself, and nothing asks for confirmation

  Scenario: Each type remembers its own questions
    Given the "Pick one option" film example is loaded
    When the person chooses "Yes or no", then "Pick one option" again
    Then the film question is back, with its options
    # Decision (owner, 2026-11-13): remember each type's questions instead of asking before discarding them, which
    # issue #102 proposed. Switching back and forth then never loses work and never needs a dialog.

  Scenario: An example loads for the chosen type only
    Given "Yes or no" holds questions the person wrote
    When the person chooses "Pick one option" and loads the film example
    Then "Pick one option" holds the film example, and "What the model reads" holds its catalogue
    And "Yes or no" still holds the person's questions
    And the confirmation, when one is needed, asks "Load the film example for Pick one option?"

  Scenario: The JSON view follows the type
    Given the JSON view is open
    When the person chooses "Score on a scale"
    Then the textarea shows the Score on a scale request, with the same state
    When the person edits the JSON so that it is not valid, then chooses another type
    Then the type stays as it was, the error shows under the textarea, and the status line says "Fix the JSON to change the question type."
    When the person changes "primitive" in the JSON to "choice" and returns to the tree, or presses Run
    Then the radios show "Pick one option"

  Scenario: A result is labelled with the type that ran
    Given a run of "Yes or no" is in flight
    When the person chooses "Pick one option" before the answer arrives
    Then Run still reads "Running"
    And the result's heading starts "Yes or no:"

  # --- The rest of the form --------------------------------------------------------------------------------------------

  Scenario: The form's parts come in this order
    Then the form holds, in order: the error summary, the question type, the examples and the Tree or JSON choice on one row,
      the empty-state message, the tree or the JSON textarea, the images, the status line, and the Run bar
    # Decision: the Tree or JSON choice sits above the request, not after the questions as #102 listed it, because it
    # changes how everything below it is shown, and a keyboard user should meet it before the fields it rearranges.

  Scenario: Tree or JSON is a pair of native radios
    Then a fieldset with the legend "Edit the request as" holds the radios "Tree" and "JSON"
    And the choice is one tab stop
    And one stored choice applies to every question type

  Scenario: The Run bar
    Then the Run bar holds the provider choice, the sentence that describes Run, then Run
    And on screens 60em wide or more it stays at the bottom of the window while the request is on screen
    And the page keeps 12rem of scroll padding at the bottom, so the bar never covers the field that has focus
    # 12rem since #101 put the provider checkboxes in the bar (scenarios/101-compare-providers.feature).
    And on a phone it follows the request, with Run as wide as the screen

  Scenario: The results follow the request and scroll with the page
    Then the Results section comes after the request form, at full width
    And it does not scroll inside a box of its own
    # The sticky, self-scrolling results box could not be reached by keyboard in Safari.

  Scenario: Fields and buttons have edges that can be seen
    Then the borders of fields, the JSON textarea, the example buttons, and the question type options use --control-edge
    And --control-edge has at least 3:1 contrast against the surface and the well in both color schemes, as WCAG 2.2's 1.4.11 asks
    # Before, they used --line, about 1.3:1 in the dark scheme.

  # --- Fewer buttons per question ---------------------------------------------------------------------------------------

  # Decision (owner, 2026-11-13): the per-question buttons were most of the page's tab stops, so Move up, Move down,
  # and Remove go behind one "More" button per question and per score level. Alt and an arrow key still move a row
  # from any field in it (scenarios/99-notice-and-move-shortcut.feature).

  Scenario: Each question's and level's actions are behind one More button
    Given the "Yes or no" film example is loaded
    Then each question has one "More" button, named "More actions for question <id>", with aria-expanded="false"
    And its Move up, Move down, and Remove buttons are hidden until it is pressed
    # A disclosure, not an ARIA menu: once open, the actions are ordinary buttons in the tab order.

  Scenario: Escape closes the actions
    Given a question's actions are open and focus is on Move down
    When the person presses Escape
    Then the actions close and focus returns to "More"

  Scenario: A moved row keeps its actions open
    Given a question's actions are open
    When the person presses Move down
    Then the question moves down, its actions are still open, and focus is on its Move down button

  Scenario: Text buttons are large enough to hit
    Then every text button, such as "More", "Add question", and "Remove option", is at least 44px tall
