# Notebooks

`trading_ai_10_strategies_liquidity.ipynb` trains the brain the server loads (model v1.5): it keeps the main models of your last brain and adds the strategy head and the liquidity head. Open it in Google Colab (File → Open notebook → GitHub → this repo), then Runtime → Run all. It saves `guru_brain_v15.joblib` to Google Drive (`trading_ai/guru_v15/`). Upload that file in the app under Admin → System & model.

The notebook contains copies of the engine files in `backend/guru`, so the brain is trained on exactly the code the server runs. After changing any of those files, rebuild it:

```
python notebooks/build_nb10.py notebooks/trading_ai_10_strategies_liquidity.ipynb
```
