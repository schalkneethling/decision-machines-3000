Feature: Two example sets, film reviews and images, with neither loaded by default

  Background:
    Given every panel opens empty: its request is {"primitive": <primitive>, "state": "", "questions": {}} in both the tree and the JSON view
    And each panel shows a short empty-state message that points at its two load buttons
    And each panel has a group of two buttons, "Load film example" and "Load image example", labelled for that panel
    # The buttons live in each panel, not in one shared control. A panel's edits, its images, and its status line
    # are all its own, so a shared control would have to ask about three panels' edits at once and announce into
    # three status lines. Per-panel buttons also sit beside the empty-state message that names them.
    And the example data is JSON files under src/decision/examples/, loaded with `import … with { type: "json" }`
    And each example is validated with validateDecisionRequest when the module loads, never cast to the request type
    And the status line (role="status") announces only what the user caused, and nothing on initial render

  # --- The empty start ------------------------------------------------------------------------------------------------

  Scenario: A fresh page holds neither example
    Given a fresh page load with a provider selected
    When the panels render
    Then no panel holds the film example or the image example
    And each panel's empty-state message is visible
    And each Run button is disabled
    And the empty-state message says Run is off until the panel holds a request
    And no status line has announced anything

  Scenario: The JSON view agrees with the empty tree
    Given a fresh page load
    When the JSON view of the Choice panel is opened
    Then the textarea holds {"primitive": "choice", "state": "", "questions": {}} formatted over several lines

  Scenario: Editing an empty panel hides the empty-state message and enables Run
    Given a fresh page load with a provider selected
    When the person types into the Noul panel's State field
    Then the empty-state message is hidden
    And Run is enabled, and pressing it reports the first problem in the status line as it always has

  # --- Loading the film example ----------------------------------------------------------------------------------------

  Scenario: Loading the film example into an empty Choice panel
    Given an empty Choice panel
    When "Load film example" is pressed
    Then the panel holds exactly choiceExample, the content of src/decision/examples/film/choice.json
    And the tree and the JSON view agree
    And the status line announces "Film example loaded."
    And Run is enabled
    And focus is on the State field of the tree

  Scenario: Loading the film example while the JSON view is open
    Given an empty Noul panel showing its JSON view
    When "Load film example" is pressed
    Then the textarea holds the film example as formatted JSON
    And focus is on the textarea

  # --- Loading the image example ---------------------------------------------------------------------------------------

  Scenario: Loading the image example into an empty Noul panel on SubQ
    Given an empty Noul panel with SubQ Snap selected
    When "Load image example" is pressed
    Then the panel holds the image example's state and questions for Noul
    And its four sample pictures are fetched and attached through the image control, in order, as red-square.png, blue-circle.png, green-triangle.png, and busy-scene.png
    And the image control's status line announces each image added, as for any upload
    And the panel's status line announces "Image example loaded. 4 sample pictures attached."
    And focus is on the State field of the tree

  Scenario: The image example needs a provider that takes images
    Given a Choice panel holding the film example, and TypeSafe Jev selected
    When "Load image example" is pressed
    Then the status line says the image example needs a provider that takes images and that TypeSafe Jev is text only
    And the panel's request, its images, and its view are unchanged

  Scenario: The image example with no provider selected
    Given a panel and no provider selected
    When "Load image example" is pressed
    Then the status line says the image example needs a provider that takes images and that no provider is selected
    And nothing is replaced

  Scenario: The image example when the panel already holds images
    Given a Noul panel with one image attached and SubQ Snap selected
    When "Load image example" is pressed
    Then the status line says to remove the attached images first, because the example attaches its own four
    And nothing is replaced

  Scenario: A sample picture that cannot be fetched
    Given an empty Score panel with OpenAI Decisions selected, and one sample picture's request fails
    When "Load image example" is pressed
    Then the status line says the sample pictures could not be loaded
    And the panel is unchanged: it is still empty, and no image is attached

  # --- Protecting edits ------------------------------------------------------------------------------------------------

  Scenario: Loading over edits asks first, and cancelling keeps them
    Given a Noul panel in which the person has typed into the State field
    When "Load film example" is pressed and the person cancels
    Then the panel is unchanged
    And the status line announces "Nothing loaded. Your request is kept."

  Scenario: Loading over edits asks first, and agreeing replaces them
    Given a Noul panel in which the person has typed into the State field
    When "Load film example" is pressed and the person agrees
    Then the panel holds the film example
    And the status line announces "Film example loaded."

  Scenario: Loading over an unedited example does not ask
    Given a Noul panel holding the film example, untouched since it was loaded
    When "Load image example" is pressed on an image provider
    Then no question is asked, and the image example replaces the film example

  # --- The sample images -----------------------------------------------------------------------------------------------

  Scenario: Every sample image is within the catalog's caps
    Given the PNG files in src/decision/examples/images/
    When the tests run
    Then each file is a PNG by its first bytes
    And each is within capabilities.images.maxBytesPerImage of every provider that takes images
    And together they are within capabilities.images.maxBytesPerRequest of every such provider
    And there are no more of them than the smallest maxCount

  Scenario: The sample images are reproducible
    Given scripts/sample-images.ts, which draws the pictures without any dependency
    When the tests render the pictures with the same function the script uses
    Then the bytes equal the committed files, byte for byte

  Scenario: Every example file is a valid request
    Given every JSON file in src/decision/examples/
    When the tests run
    Then each one validates against every provider's capabilities with validateDecisionRequest
    And the film examples equal the previous noulExample, choiceExample, and scoreExample

  # --- Accessibility ---------------------------------------------------------------------------------------------------

  Scenario: Both load buttons are reachable and labelled
    Given keyboard-only use
    When the person tabs through a panel
    Then "Load film example" and "Load image example" are reached before the view switch
    And each sits in a group labelled "Examples for <Panel name>"
    And after loading, focus is on the first field of the loaded request

  Scenario: Nothing is announced on initial render
    Given a fresh page load
    When the panels render
    Then every panel status line and every image control status line is empty

  # --- Manual live check (the coordinator runs it) -------------------------------------------------------------------

  Scenario: The image example runs on both image providers
    Given vp dev is running with real SubQ and OpenAI keys
    And SubQ Snap is selected
    When "Load image example" is pressed in each of the three panels, and each panel is run
    Then every answer is about the sample pictures: image 1 is red, image 2 is a circle, image 3 has straight edges only, and image 4 is the cluttered one
    And the same holds after switching to OpenAI Decisions, loading the image example again, and running the three panels
    And the wire view shows four image placeholders for each run
