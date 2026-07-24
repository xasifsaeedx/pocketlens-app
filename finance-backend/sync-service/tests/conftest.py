import os
import sys

# Make the sync-service modules (sync, categorizer, ...) importable no matter
# where pytest is invoked from.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
