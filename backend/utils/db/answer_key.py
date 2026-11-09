"""Correct answers for the test, used to mark each saved answer right or wrong.

Kept on the server, not in the test pages, so participants can't find them in
the page source; participants are never told whether they were right.
Keyed by page id, as in frontend/exam1.html. Changing an answer here also
re-marks answers already saved, the next time the backend starts.
"""

# Questions 1-100: the CaMLA English Placement Test, Form A (scoring key sent
# by the professor, Nov 2026)...
FORM_A = (
    "bcaacbbacc" "babcaacbca" "dbcdb"        # 1-25
    "aabcdadcbd" "bcaadbbacd" "dcadb"        # 26-50
    "acbdbaccad" "dcbacdadca" "bcdab"        # 51-75
    "cbdabadcca" "dbbcadcadb" "adbcc"        # 76-100
)

ANSWER_KEY: dict[str, str] = {f"q{i + 1}": letter for i, letter in enumerate(FORM_A)}

# ...except question 36 ("I thought you ____ in Texas."): the key says b, but
# on our page b is "were borne" and a is "were born", so our choices are
# probably in a different order from the paper booklet.
ANSWER_KEY["q36"] = "a"

# Reading passages (MECOL2.xlsx came without answers): worked out from the
# passages, two questions each, passage 1 to 12.
READING = "ac cb bc ac aa bd bd ac ca ad bb dd".split()
for passage, letters in enumerate(READING, start=1):
    for question, letter in enumerate(letters, start=1):
        ANSWER_KEY[f"passage-{passage}-q{question}"] = letter
