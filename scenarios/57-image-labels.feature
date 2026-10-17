Feature: Show how to ask about attached images, and label each image for the model

  Background:
    Given each attached image reaches the Worker as a file part, and the Worker keeps its file name beside its media type, base64 data, and byte length
    And the file name is user-controlled text, so it is cleaned and clipped before it is kept:
      | rule                                                                                        |
      | only the part after the last "/" or "\" is kept                                              |
      | control, format, and separator characters (including line breaks and bidi marks) are removed |
      | runs of whitespace become one space, and the ends are trimmed                                |
      | at most 80 characters (code points) are kept, and a clipped name ends with "…"               |
      | a name with nothing left is labelled by its number alone, "Image 1"                          |
    And no log line and no message the Worker writes itself contains a file name

  # --- The hint in the image control ---------------------------------------------------------------------------------

  Scenario: The control tells the user to refer to the images
    Given an image provider is selected
    When the panel's image control renders
    Then its instructions say to ask about the images in the state or a question, for example "What does image 1 show?"
    And that line's id is part of the file input's aria-describedby

  Scenario: A text-only provider shows no hint
    Given a text-only provider is selected
    When the panel renders
    Then the image control, with its hint, is hidden

  # --- OpenAI --------------------------------------------------------------------------------------------------------

  Scenario: OpenAI gets a label before each image, in the user message
    Given images "a.png" and "b.jpg" are attached in that order on OpenAI
    When Run builds the provider request
    Then input is one user message whose content is:
      | order | part                                    |
      | 1     | input_text: the state                   |
      | 2     | input_text: "Image 1: a.png"            |
      | 3     | input_image: a.png as a data: URL       |
      | 4     | input_text: "Image 2: b.jpg"            |
      | 5     | input_image: b.jpg as a data: URL       |

  Scenario: OpenAI without images is unchanged
    Given no images are attached on OpenAI
    When Run builds the provider request
    Then input is the state text, as before

  # --- SubQ ----------------------------------------------------------------------------------------------------------

  Scenario: SubQ gets the labels as lines after a text state
    Given images "a.png" and "b.jpg" are attached in that order on SubQ and the state is text
    When Run builds the provider request
    Then state is the text, a blank line, then "Image 1: a.png" and "Image 2: b.jpg" on their own lines
    And images lists the two images in the same order, with only mediaType and base64

  Scenario: SubQ is left without labels when its state is an object or a list
    Given images are attached on SubQ and the state is an object or a list
    When Run builds the provider request
    Then state is sent exactly as written, because wrapping it would change what SubQ scores
    And the images still follow in order

  Scenario: SubQ without images is unchanged
    Given no images are attached on SubQ
    When Run builds the provider request
    Then state is sent exactly as written

  # --- File names ----------------------------------------------------------------------------------------------------

  Scenario: A 300-character name is clipped
    Given an image whose file name is 300 characters long
    When the Worker labels it
    Then the label holds at most 80 characters of the name, ending with "…"

  Scenario: Control characters are removed
    Given an image whose file name holds a line break, a tab, and a right-to-left override
    When the Worker labels it
    Then the label is one line, with those characters gone

  Scenario: No log line carries a file name
    Given a run with images, successful or failed
    When the route logs it
    Then the log line holds the image count and no file name

  # --- The wire view -------------------------------------------------------------------------------------------------

  Scenario: The wire view shows what the model saw
    Given a run with two images on OpenAI
    When the wire view renders "Sent to OpenAI"
    Then each "Image n: name" label sits directly before that image's "<image n: type, size>" placeholder
    And on SubQ the labels are in the state text, which the same block shows

  # --- Manual live check (the coordinator runs it) -------------------------------------------------------------------

  Scenario: Both providers answer about the second image
    Given vp dev is running with real SubQ and OpenAI keys
    And two clearly different images are attached, for example a red square first and a blue circle second
    When the question "What colour is image 2?" is run on SubQ, then on OpenAI
    Then both answers are about the second image
    And the wire view shows "Image 1: <name>" and "Image 2: <name>"
    And no 422 or 400 comes back from either provider for the extra text parts or the longer state
