import os 
lines=['Default model: zai:glm-5.2','','Available models:'] 
lines += ['  - xai:grok-model-'+str(i).zfill(3) for i in range(1,196)] 
lines += ['  * zai:glm-5.2 (default)'] 
open('grok_models_output.txt','w').write('\n'.join(lines)+'\n') 
